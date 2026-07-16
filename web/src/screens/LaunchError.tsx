/**
 * Launch-error screen, componentized from
 * ui-ideas/mytribe-launch-error-2026-05-31.html. Shown when the home
 * payload cannot be loaded (network down, backend error).
 */
export function LaunchError(props: { onRetry: () => void; onSignOut: () => void; retrying?: boolean; signingOut?: boolean }) {
  return (
    <main className="errshell">
      <div className="errbrand">
        My<span className="grad">Tribe</span>
      </div>

      <section className="glass card launcherrcard">
        <div className="petglow">
          <span className="ring" />
          <span className="ring two" />
          <span className="face">{'\u{1F436}'}</span>
        </div>

        <div className="paws">
          <span className="ln" />
          {'\u{1F43E}'}
          <span className="ln" />
        </div>

        <h3 className="title errmsg">We're having trouble loading your tribe.</h3>

        <p className="errhelp">Nothing is lost, your pack is safe. Give it another try in a moment.</p>

        <div className="erractions">
          <button className="btn grad block" onClick={props.onRetry} disabled={props.retrying ?? false}>
            {props.retrying ? 'Trying…' : '↻ Try again'}
          </button>
          <button className="btn ghost block" onClick={props.onSignOut} disabled={props.signingOut ?? false}>
            {props.signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </section>

      <p className="errfoot">
        Cared for by <b>Tribe Tails Pet Care</b>
      </p>
    </main>
  );
}
