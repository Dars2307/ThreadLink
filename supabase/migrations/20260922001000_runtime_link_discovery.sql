-- ===========================================================================
-- Phase 6.6 — Runtime-scoped link discovery
--
-- A Runtime used to find link requests only by asking about the conversations
-- it still had in its own local files. Detaching a conversation while a
-- request was pending therefore hid that request from the only place it could
-- be approved, with no way back: a dead end for the user.
--
-- Discovery now comes from the server. A Runtime asks ThreadLink which of ITS
-- sessions have links, and gets back what it needs to show the request and to
-- offer reattaching the right Claude conversation.
--
-- Scope is the Runtime, never the user: a second Runtime belonging to the same
-- person sees nothing of this one's links. The controller's session id is
-- deliberately withheld - the Runtime never needs it, and approval is by
-- (agent session, link), which approve_pairing re-checks anyway.
-- ===========================================================================

create function public.list_runtime_links(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Both of these fail closed: an unknown or revoked credential never gets
  -- past require_connection, and a non-agent connection or a Runtime that is
  -- not registered/active never gets past require_runtime.
  v_connection public.connections := threadlink_private.require_connection(p_token_hash);
  v_runtime public.runtimes := threadlink_private.require_runtime(v_connection);
begin
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', l.id,
        'status', l.status,
        'paused', l.paused,
        'agent_session_id', l.agent_session_id,
        -- Who is asking, in words. Never the controller's session id.
        'controller_display_name', coalesce(cs.display_name, cc.display_name),
        'requested_at', l.requested_at,
        'approved_at', l.approved_at,
        -- Enough to find (or reattach) the exact conversation locally.
        'conversation', jsonb_build_object(
          'display_name', ag.display_name,
          'local_binding_ref', ag.local_binding_ref,
          'provider', ag.provider,
          'mode', ag.native_session_mode,
          'native_session_id', ag.native_provider_session_id,
          'workspace_id', ag.workspace_id,
          'workspace_name', ws.display_name,
          'workspace_path', ws.path
        )
      )
      order by l.requested_at desc
    )
    from public.thread_links l
    join public.session_bindings ag
      on ag.id = l.agent_session_id and ag.owner_user_id = l.owner_user_id
    join public.session_bindings cs
      on cs.id = l.controller_session_id and cs.owner_user_id = l.owner_user_id
    -- The controller's connection, for its display name only ("ChatGPT").
    join public.connections cc on cc.id = cs.connection_id
    left join public.runtime_workspaces ws
      on ws.id = ag.workspace_id and ws.owner_user_id = l.owner_user_id
    where l.owner_user_id = v_connection.owner_user_id
      -- The heart of it: sessions placed on THIS Runtime, nothing else.
      and ag.runtime_id = v_runtime.id
      and ag.connection_id = v_connection.id
      and l.status in ('pending', 'active')
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_runtime_links(text) is
  'Link requests for sessions owned by the calling Runtime, so a request stays '
  'visible even when its conversation is detached locally.';

revoke all on function public.list_runtime_links(text) from public;
grant execute on function public.list_runtime_links(text) to anon, authenticated;
