import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getTribeSummaries } from '../api/portal';
import { useSignOut } from '../lib/auth';
import { setActiveKinfolkId, useAccessState } from '../lib/activeTribe';

const AVATAR_VARIANTS = ['', 't2', 't3'] as const;

/**
 * Multi-tribe chooser, ported from ui-ideas/mytribe-tribe-picker-2026-05-31.html.
 * Shown for operators (always) and non-operator kinfolk who belong to 2+
 * households (Kotlin's LaunchDestination.Pick). Per-tribe subtitle counts in
 * the mockup are flagged there as illustrative only ("SUGGESTION ... not in
 * contract") — TribeSummary only carries id + displayName, so we render that.
 */
export function TribePicker() {
  const navigate = useNavigate();
  const access = useAccessState();
  const kinfolkIds = access?.kinfolkIds ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  const summaries = useQuery({
    queryKey: ['tribeSummaries', kinfolkIds],
    queryFn: () => getTribeSummaries(kinfolkIds),
    enabled: kinfolkIds.length > 0,
  });

  useEffect(() => {
    if (selected === null && summaries.data && summaries.data.length > 0) {
      setSelected(summaries.data[0]!.id);
    }
  }, [summaries.data, selected]);

  const { signOut, signingOut } = useSignOut();

  function handleEnter() {
    if (!selected) return;
    setActiveKinfolkId(selected);
    void navigate({ to: '/home' });
  }

  return (
    <main className="picker">
      <div className="brandhead">
        <div className="wordmark" style={{ fontSize: 28 }}>
          My<span className="grad">Tribe</span>
        </div>
      </div>

      <section className="glass card" style={{ padding: '30px 26px' }}>
        <header className="pickhead">
          <h1>Choose a Tribe</h1>
          <p className="sub">
            {access?.isOperator
              ? 'You have access to every household. Pick the one you want to step into.'
              : 'You belong to a few households. Pick the one you want to step into.'}
          </p>
        </header>

        <div className="sectlabel" style={{ marginTop: 4 }}>
          Your tribes
        </div>

        {summaries.isLoading ? (
          <p className="sub">Loading your tribes…</p>
        ) : summaries.isError ? (
          <p className="sub">Couldn&rsquo;t load your tribes. Try again.</p>
        ) : (
          <div className="tribelist">
            {(summaries.data ?? []).map((tribe, i) => (
              <button
                key={tribe.id}
                type="button"
                className={`tribe ${AVATAR_VARIANTS[i % AVATAR_VARIANTS.length]} ${selected === tribe.id ? 'sel' : ''}`}
                onClick={() => setSelected(tribe.id)}
              >
                <div className="avatar">{tribe.displayName.charAt(0).toUpperCase() || 'T'}</div>
                <div className="tinfo">
                  <b>{tribe.displayName}</b>
                </div>
                <span className="chev">{'›'}</span>
              </button>
            ))}
          </div>
        )}

        <div className="pickfoot">
          <button type="button" className="btn grad block" disabled={!selected} onClick={handleEnter}>
            Enter this Tribe
          </button>
          <p className="hint">You can switch tribes anytime from your account.</p>
        </div>
      </section>

      <p className="footnote" style={{ marginTop: 24 }}>
        A home for <b>your whole tribe</b>
      </p>
      <div className="forgotrow">
        {/* An anchor ignores `disabled`; useSignOut's ref guard is the real
            double-tap defence, aria-disabled just tells AT the same story. */}
        <a onClick={signOut} aria-disabled={signingOut} style={signingOut ? { opacity: 0.5 } : undefined}>
          {signingOut ? 'Signing out…' : 'Sign Out'}
        </a>
      </div>
    </main>
  );
}
