// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MergePreview } from './MergePreview';

/**
 * The preview exists to make the sent artifact visible before it is sent, and
 * to name the spots that will arrive blank. Both halves are asserted here: the
 * substituted text a customer would read, and the `role="status"` line that
 * counts what nothing binds.
 */
describe('MergePreview', () => {
  it('warns once per unresolved field and names the count', () => {
    render(
      <MergePreview
        subject="Welcome"
        body="Hi {{kinfolkName}}, see {{link}}."
        sample={{ kinfolkName: 'Sandy' }}
      />,
    );
    expect(screen.getByText('Sandy')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 merge field has no sample value: link');
  });

  it('says nothing when every field resolves', () => {
    render(<MergePreview subject="Welcome" body="Hi {{kinfolkName}}." sample={{ kinfolkName: 'Sandy' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('pluralizes the warning and names every distinct key', () => {
    render(<MergePreview subject="Welcome" body="{{link}} {{code}} {{link}}" sample={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 merge fields have no sample value: link, code',
    );
  });

  it('counts an unresolved field in the SUBJECT, not only the body', () => {
    // The subject is the first thing a kinfolk reads and it goes through the
    // same Handlebars compile (email.ts#sendTemplatedEmail compiles
    // subjectTemplate too), so a blank there is the same defect.
    render(<MergePreview subject="Your {{serviceType}} is confirmed" body="All set." sample={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 merge field has no sample value: serviceType',
    );
  });

  it('renders the subject and the plain body text a kinfolk would read', () => {
    render(
      <MergePreview
        subject="A Kinfolk just finished setting up"
        body="See their account here: []"
        sample={{}}
      />,
    );
    expect(screen.getByText('A Kinfolk just finished setting up')).toBeInTheDocument();
    expect(screen.getByText(/See their account here: \[\]/)).toBeInTheDocument();
  });

  it('shows an unresolved token in its raw form so the author can find it in the source', () => {
    render(<MergePreview subject="Hi" body="see {{link}}" sample={{}} />);
    expect(screen.getByText('{{link}}')).toBeInTheDocument();
  });

  it('renders an empty-string binding as an empty chip, and does not warn about it', () => {
    render(<MergePreview subject="Hi" body="Notes: {{notes}}" sample={{ notes: '' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders the footnote a consumer supplies, for what happens at send', () => {
    render(
      <MergePreview subject="Hi" body="Body." sample={{}} footnote="Merge fields resolve at send." />,
    );
    expect(screen.getByText('Merge fields resolve at send.')).toBeInTheDocument();
  });

  it('renders an empty body without crashing and prompts for copy', () => {
    render(<MergePreview subject="" body="" sample={{}} />);
    expect(screen.getByText(/Nothing to preview yet/)).toBeInTheDocument();
  });

  it('labels the region so a screen reader can find it', () => {
    render(<MergePreview subject="Hi" body="Body." sample={{}} />);
    expect(screen.getByRole('region', { name: 'Live preview' })).toBeInTheDocument();
  });
});
/**
 * The HTML half. `sendTemplatedEmail` compiles `htmlTemplate` when the template
 * has one, and that is the version most recipients actually see, so a preview
 * that renders the plain-text body and says nothing about the HTML is claiming
 * to show what a kinfolk receives while omitting it. Android has surfaced this
 * notice since AuntieEmailPreviewCard was written; React had not.
 */
describe('MergePreview: a template that also carries HTML', () => {
  it('says so, rather than previewing the text body as if it were the whole email', () => {
    render(
      <MergePreview subject="Hi" body="Plain text." sample={{}} html="<p>Rich body</p>" />,
    );
    expect(screen.getByText('HTML body provided. Preview shows plain text only.')).toBeInTheDocument();
  });
  it('stays quiet when there is no HTML', () => {
    render(<MergePreview subject="Hi" body="Plain text." sample={{}} />);
    expect(screen.queryByText(/HTML body provided/)).not.toBeInTheDocument();
  });
  it('treats a blank HTML field as no HTML, which is what an untouched textarea gives', () => {
    render(<MergePreview subject="Hi" body="Plain text." sample={{}} html="   " />);
    expect(screen.queryByText(/HTML body provided/)).not.toBeInTheDocument();
  });
  it('still counts merge fields inside the HTML, which send blank just the same', () => {
    render(<MergePreview subject="Hi" body="Plain." sample={{}} html='<a href="{{link}}">Account</a>' />);
    expect(screen.getByRole('status')).toHaveTextContent('1 merge field has no sample value: link');
  });
});
