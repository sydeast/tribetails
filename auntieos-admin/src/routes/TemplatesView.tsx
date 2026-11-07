import { useNavigate, useSearch } from '@tanstack/react-router';
import { Templates } from '../screens/Templates';

/**
 * Adapts `/templates?template=<id|new>` to Templates' props (#1594).
 *
 * The open editor lives in the URL, so a reload returns to the template being
 * edited instead of the bank, and Back from the editor lands on the bank.
 * Opening PUSHES an entry (the editor is a page of its own); closing pushes
 * the bare `/templates`, the same way the editor's crumb trail reads.
 */
export function TemplatesView() {
  const { template } = useSearch({ from: '/admin/templates' });
  const navigate = useNavigate();
  return (
    <Templates
      {...(template ? { editorTemplateId: template } : {})}
      onEditorChange={(id) =>
        void navigate({ to: '/templates', search: id === null ? {} : { template: id } })
      }
    />
  );
}
