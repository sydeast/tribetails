// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { uploadEmailImage } = vi.hoisted(() => ({ uploadEmailImage: vi.fn() }));
vi.mock('../../api/emailImageUpload', async (orig) => ({
  ...(await orig<typeof import('../../api/emailImageUpload')>()),
  uploadEmailImage,
}));

import { FieldDialog, ImageDialog, TargetDialog } from './EmailEditorDialogs';

const file = (name: string, type: string, bytes: number) =>
  Object.defineProperty(new File(['x'], name, { type }), 'size', { value: bytes });

describe('TargetDialog (Button)', () => {
  it('builds a button to a web address, adding https to a bare domain', async () => {
    const onSubmit = vi.fn();
    render(
      <TargetDialog
        title="Button"
        withLabel
        allowMailto={false}
        fields={['link']}
        initial={{ label: '', href: '' }}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText('Button text'), 'Book a visit');
    await userEvent.type(screen.getByLabelText('Address'), 'tribetails.com/book');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ label: 'Book a visit', href: 'https://tribetails.com/book' });
  });

  it('builds a button to a merge field', async () => {
    const onSubmit = vi.fn();
    render(
      <TargetDialog
        title="Button"
        withLabel
        allowMailto={false}
        fields={['displayName', 'link']}
        initial={{ label: 'Reset', href: '' }}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByLabelText('A merge field'));
    await userEvent.selectOptions(screen.getByLabelText('Field'), 'link');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ label: 'Reset', href: '{{link}}' });
  });

  it('opens on an existing button with its field selected', () => {
    render(
      <TargetDialog
        title="Button"
        withLabel
        allowMailto={false}
        fields={['displayName']}
        initial={{ label: 'Go', href: '{{link}}' }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('A merge field')).toBeChecked();
    expect(screen.getByLabelText('Field')).toHaveValue('link');
  });

  it('refuses plain http and an empty label, saying what to do', async () => {
    const onSubmit = vi.fn();
    render(
      <TargetDialog
        title="Button"
        withLabel
        allowMailto={false}
        fields={[]}
        initial={{ label: '', href: '' }}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type the button text.');
    await userEvent.type(screen.getByLabelText('Button text'), 'Go');
    await userEvent.type(screen.getByLabelText('Address'), 'http://tribetails.com');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type a web address starting with https://.');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('A merge field')).toBeDisabled();
  });
});

describe('TargetDialog (Link)', () => {
  it('takes an email address as mailto, and offers Remove link when editing one', async () => {
    const onSubmit = vi.fn();
    const onRemove = vi.fn();
    render(
      <TargetDialog
        title="Link"
        withLabel={false}
        allowMailto
        fields={[]}
        initial={{ label: '', href: 'https://old.com' }}
        onSubmit={onSubmit}
        onRemove={onRemove}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Button text')).toBeNull();
    await userEvent.clear(screen.getByLabelText('Address'));
    await userEvent.type(screen.getByLabelText('Address'), 'auntie@tribetails.com');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSubmit).toHaveBeenCalledWith({ label: '', href: 'mailto:auntie@tribetails.com' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onRemove).toHaveBeenCalled();
  });
});

describe('ImageDialog', () => {
  // applyAccept: false, so a PDF reaches the input the way a drag-drop or a
  // browser that ignores `accept` would deliver it.
  const user = () => userEvent.setup({ applyAccept: false });

  it('refuses a PDF before uploading anything', async () => {
    render(<ImageDialog onInsert={vi.fn()} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('menu.pdf', 'application/pdf', 1000));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a JPG, PNG, GIF or WebP image.');
    await user().type(screen.getByLabelText('Description'), 'Menu');
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(uploadEmailImage).not.toHaveBeenCalled();
  });

  it('refuses a 12 MB photo before uploading anything', async () => {
    render(<ImageDialog onInsert={vi.fn()} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('huge.jpg', 'image/jpeg', 12 * 1024 * 1024));
    expect(screen.getByRole('alert')).toHaveTextContent('That image is 12.0 MB. Pick one under 5 MB.');
    expect(uploadEmailImage).not.toHaveBeenCalled();
  });

  it('refuses a merge field in the description before uploading anything', async () => {
    // #953 ruling C9: the server refuses a `{{` in any attribute but `href`.
    // fireEvent.change, not userEvent.type: userEvent treats `{`/`}` as key
    // syntax, so a literal `{{token}}` cannot be typed with it directly.
    render(<ImageDialog onInsert={vi.fn()} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('pup.png', 'image/png', 1000));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Photo of {{displayName}}' } });
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(screen.getByRole('alert')).toHaveTextContent("Merge fields can't go in an image description.");
    expect(uploadEmailImage).not.toHaveBeenCalled();
  });

  it('shows each upload stage, then inserts the image with its description', async () => {
    let finish: (url: string) => void = () => {};
    uploadEmailImage.mockImplementation((_f: File, onStage: (s: string) => void) => {
      onStage('uploading');
      return new Promise((r) => {
        finish = r;
      });
    });
    const onInsert = vi.fn();
    render(<ImageDialog onInsert={onInsert} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('pup.png', 'image/png', 1000));
    await user().type(screen.getByLabelText('Description'), 'Two dogs on a walk');
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(screen.getAllByText('Uploading image…').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish('https://res.cloudinary.com/t/image/upload/pup.png');
    await vi.waitFor(() =>
      expect(onInsert).toHaveBeenCalledWith({ src: 'https://res.cloudinary.com/t/image/upload/pup.png', alt: 'Two dogs on a walk' }),
    );
  });

  it('a failed upload says so and inserts nothing', async () => {
    uploadEmailImage.mockRejectedValue(new Error('Upload signing failed (HTTP 500): boom'));
    const onInsert = vi.fn();
    render(<ImageDialog onInsert={onInsert} onClose={vi.fn()} />);
    await user().upload(screen.getByLabelText('Image file'), file('pup.png', 'image/png', 1000));
    await user().type(screen.getByLabelText('Description'), 'Pup');
    await user().click(screen.getByRole('button', { name: 'Upload and insert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The upload didn’t finish: Upload signing failed (HTTP 500): boom');
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Upload and insert' })).toBeEnabled();
  });
});

describe('FieldDialog', () => {
  it('lists the fields and picks one', async () => {
    const onPick = vi.fn();
    render(<FieldDialog fields={['displayName', 'link']} state="ready" note={undefined} onPick={onPick} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '{{link}}' }));
    expect(onPick).toHaveBeenCalledWith('link');
  });

  it('shows a loading cue while the fields load', () => {
    render(<FieldDialog fields={[]} state="loading" note={undefined} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText('Loading fields…').length).toBeGreaterThan(0);
  });

  it('says so when the fields could not load', () => {
    render(<FieldDialog fields={['inviteLink']} state="error" note={undefined} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load this template’s fields. These are the fields it already uses.');
    expect(screen.getByRole('button', { name: '{{inviteLink}}' })).toBeInTheDocument();
  });

  it('never offers a loop-scoped this/this.* token, whatever the caller passes in', () => {
    // #953 carry-forward: the guarantee holds at the dialog boundary too, not
    // only in fieldsForTemplate's own fallback.
    render(
      <FieldDialog fields={['this', 'this.weekday', 'link']} state="ready" note={undefined} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: '{{link}}' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '{{this}}' })).toBeNull();
    expect(screen.queryByRole('button', { name: '{{this.weekday}}' })).toBeNull();
  });
});
