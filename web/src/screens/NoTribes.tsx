import { useQuery } from '@tanstack/react-query';
import { getBusinessContact } from '../api/portal';
import { useSignOut } from '../lib/auth';

/**
 * Shown when getMyAccess returns zero kinfolkIds — signed in but not yet
 * attached to a household. Ported from
 * src/commonMain/kotlin/com/kinfolk/portal/ui/NoTribesOnboarding.kt.
 * "Message Auntie" opens a mailto: to the business contact (no full
 * messaging composer here — that's the sendKinfolkMessage/TipTap surface
 * planned for S5, and it needs a kinfolkId this screen doesn't have yet).
 */
export function NoTribes() {
  const contact = useQuery({ queryKey: ['businessContact'], queryFn: getBusinessContact });
  const { signOut, signingOut } = useSignOut();

  const mailHref = contact.data?.email ? `mailto:${contact.data.email}?subject=${encodeURIComponent('Getting started with MyTribe')}` : undefined;

  return (
    <main className="picker">
      <div className="brandhead">
        <div className="wordmark" style={{ fontSize: 28 }}>
          My<span className="grad">Tribe</span>
        </div>
      </div>

      <section className="glass card notribes-card" style={{ padding: '30px 26px' }}>
        <h1>Welcome to MyTribe!</h1>
        <p>
          We&rsquo;re so glad you&rsquo;re here. Your Auntie is putting the final touches on your Tribe — once you&rsquo;re set up, this is
          where you&rsquo;ll find live visits, KinTales, schedules, and everything that keeps your Kin happy.
        </p>
        <p className="sub">If you&rsquo;ve got questions or need help getting started, send your Auntie a message and she&rsquo;ll get you sorted.</p>

        <div className="pickfoot">
          {mailHref ? (
            <a className="btn grad block" href={mailHref}>
              Message Auntie
            </a>
          ) : (
            <span className="btn grad block navlink-inert" title="Loading contact info…">
              Message Auntie
            </span>
          )}
        </div>
      </section>

      <div className="forgotrow" style={{ marginTop: 24 }}>
        {/* An anchor ignores `disabled`; useSignOut's ref guard is the real
            double-tap defence, aria-disabled just tells AT the same story. */}
        <a onClick={signOut} aria-disabled={signingOut} style={signingOut ? { opacity: 0.5 } : undefined}>
          {signingOut ? 'Signing out…' : 'Sign Out'}
        </a>
      </div>
    </main>
  );
}
