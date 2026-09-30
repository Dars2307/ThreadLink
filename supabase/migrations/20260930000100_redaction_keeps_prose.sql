-- ThreadLink 0.11.3: chat redaction keeps a mid-sentence "pass:" readable.
--
-- Found in Production: an agent's review "Follow-up after a deeper pass: ..."
-- was stored as "Follow-up after a deeper pass: [redacted]" because a bare
-- "pass:" anywhere hid the rest of the line. "pass=" still does, anywhere;
-- "pass:" still does as a label at the start of a line. Every other rule is
-- unchanged. Replaces one function; no table or data change.

create or replace function threadlink_private.redact_text(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := p;
  r constant text := '[redacted]';
begin
  if t is null then
    return null;
  end if;
  -- PEM private keys (base64 bodies contain no '-').
  t := pg_catalog.regexp_replace(t,
    '-----BEGIN[A-Z ]*PRIVATE KEY-----[^-]*(-----END[A-Z ]*PRIVATE KEY-----)?', r, 'g');
  -- Slack incoming-webhook URLs are credentials in themselves.
  t := pg_catalog.regexp_replace(t, 'https?://hooks\.slack\.com/(services|workflows)/[A-Za-z0-9/_-]+', r, 'gi');
  -- Credentials inside a URL: scheme://user:password@host, including an empty user.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z][A-Za-z0-9+.-]*://)[^[:space:]/:@]*:[^[:space:]/@]+@', '\1' || r || '@', 'g');
  -- Authorization: Bearer / Basic <token>.
  t := pg_catalog.regexp_replace(t, '(bearer|basic)([[:space:]]+)[A-Za-z0-9._~+/=-]{8,}', '\1\2' || r, 'gi');
  -- Cookie headers: the rest of the line.
  t := pg_catalog.regexp_replace(t, '((set-)?cookie[[:space:]]*:)[^\n]*', '\1 ' || r, 'gi');
  -- AWS CLI style: `aws_secret_access_key <value>` (whitespace, no '=').
  t := pg_catalog.regexp_replace(t,
    '((aws_secret_access_key|aws_session_token|aws_access_key_id)[[:space:]]+)[^[:space:]=:]+', '\1' || r, 'gi');
  -- "the password is X", only when X looks like a secret (a digit in it, or
  -- 16+ characters, optionally quoted): "an expired token is still accepted"
  -- is prose and stays readable (0.11; mirrors runtime/src/summary.ts).
  t := pg_catalog.regexp_replace(t,
    '((password|passphrase|passwd|secret|token|api[ _-]?key)[[:space:]]+(is|was)[[:space:]]+)'
    || '(["''`]?[^[:space:]]*[0-9][^[:space:]]*|[^[:space:]]{16,})',
    '\1' || r, 'gi');
  -- key = value / key: value where the key names a secret; the value runs to
  -- the end of the line.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z0-9_-]*(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)'
    || '[A-Za-z0-9_-]*["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
    '\1' || r, 'gi');
  -- 0.10: env / shell / YAML / JSON names ending in KEY, PASS, CREDS,
  -- CREDENTIALS (upper case, or lower case after an underscore).
  t := pg_catalog.regexp_replace(t,
    '(\m[A-Za-z0-9_]*(KEY|PASS|CREDS?|CREDENTIALS?|Key|Pass|Creds?|Credentials?|_key|_pass|_creds?|_credentials?)'
    || '["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
    '\1' || r, 'g');
  -- ...and credential(s) / creds in any case...
  t := pg_catalog.regexp_replace(t,
    '(\m[A-Za-z0-9_-]*(credentials?|creds)["'']?[[:space:]]*[:=][[:space:]]*)[^\n]+',
    '\1' || r, 'gi');
  -- ...and a bare "pass": "pass=" anywhere, and "pass:" as a label at the
  -- start of a line (after an optional list bullet). Mid-sentence, "a deeper
  -- pass: the handler ..." is prose and stays readable (0.11.3).
  t := pg_catalog.regexp_replace(t, '(\mpass["'']?[[:space:]]*=[[:space:]]*)[^\n]+', '\1' || r, 'gi');
  t := pg_catalog.regexp_replace(t,
    '((^|\n)[[:space:]]*([-*•][[:space:]]*)?pass["'']?[[:space:]]*:[[:space:]]*)[^\n]+', '\1' || r, 'gi');
  -- Provider keys.
  t := pg_catalog.regexp_replace(t, '\m(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}', r, 'gi');
  t := pg_catalog.regexp_replace(t, '\mgithub_pat_[A-Za-z0-9_]{20,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mgh[pousr]_[A-Za-z0-9]{16,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mxox[abprse]-[A-Za-z0-9-]{10,}', r, 'gi');
  t := pg_catalog.regexp_replace(t, '\m(AKIA|ASIA)[0-9A-Z]{12,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mAIza[0-9A-Za-z_-]{30,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mglpat-[A-Za-z0-9_-]{20,}', r, 'g');
  t := pg_catalog.regexp_replace(t, '\mnpm_[A-Za-z0-9]{30,}', r, 'g');
  -- ThreadLink connection credentials.
  t := pg_catalog.regexp_replace(t, '\mtlc_[A-Za-z0-9_-]{16,}', r, 'g');
  -- JWTs.
  t := pg_catalog.regexp_replace(t, '\meyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}', r, 'g');
  -- A home directory names a person.
  t := pg_catalog.regexp_replace(t,
    '([A-Za-z]:[\\/](Users|Documents and Settings)[\\/])[^\\/[:space:]"''<>|]+', '\1' || U&'\2026', 'gi');
  t := pg_catalog.regexp_replace(t, '(/(home|Users)/)[^/[:space:]"''<>|]+', '\1' || U&'\2026', 'g');
  return t;
end;
$$;
