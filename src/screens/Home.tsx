import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';

/**
 * Home screen content. The nav rail + topbar live in AppShell (the layout route),
 * so this is just the page body rendered into the shell's <Outlet/>.
 */
export function Home() {
  // Screens render a <div>, not <main>: AppShell owns the single <main> landmark
  // (B1). Nesting <main> in <main> is invalid and breaks landmark navigation — the
  // exact a11y this rebuild restores. Every screen follows this.
  return (
    <div className="screen">
      <DenScreenHeading kicker="Overview" title="Home" subtitle="AuntieOS admin — React rebuild" />
      <DenPanel title="Band B: data layer online">
        <p>
          The typed callable seam (api/) and the first real vertical (Feature Flags)
          are live on the new stack. More screens land band by band.
        </p>
      </DenPanel>
    </div>
  );
}
