# Acknowledgments

## claudex-loop

ThreadLink's Team Mode was designed after studying
[claudex-loop](https://github.com/chaseai-yt/claudex-loop) by Chase AI (MIT License),
at commit `8cf5e2c1771c5151d90c12642391d0ba8fa71b0e`.

**Concepts only; no code, prompt text or schemas were copied.** ThreadLink
reimplements, independently and in TypeScript, the ideas it found worth adopting:

- a reviewer that is always a different provider from the author;
- approval tied to a content hash of exactly what was reviewed, invalidated by
  any later change;
- a fresh, independent final inspection over the whole change;
- a strict rule that an approval with a blocking or important finding is not an
  approval;
- verifying that a resumed agent session is the same session;
- running the proof commands itself rather than taking an agent's report.

Where claudex-loop expresses rules in prose (round limits, arbitration, the review
log), ThreadLink enforces them in code and in the database. Where it inherits the
user's configuration or environment, ThreadLink deliberately does not.

The full study, including what was not adopted and why, is in
[docs/research/claudex-loop-review.md](docs/research/claudex-loop-review.md).

Because nothing was copied, the MIT license imposes no notice obligation on
ThreadLink. This acknowledgment is given as a matter of good practice. Should any
claudex-loop code or text ever be adopted, its copyright and permission notice must
be added to a `THIRD-PARTY-NOTICES.md` file, as set out in section 5 of the review.
