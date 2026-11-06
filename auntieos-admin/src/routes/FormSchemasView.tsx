import { useState } from 'react';
import { FormSchemas } from '../screens/FormSchemas';
import { FormSchemaEditor } from '../screens/FormSchemaEditor';

/**
 * List and editor in one route. `null` is the list alone; a value opens the
 * editor as a workflow modal OVER the list rather than in place of it, which is
 * what the operator asked for on 2026-08-08 and what makes backing out land on
 * the row that was clicked instead of on a re-rendered list.
 */
export function FormSchemasView() {
  const [editor, setEditor] = useState<{ id?: string } | null>(null);
  // #1615: a save changes the list, and the list used to keep showing what it
  // loaded before the editor opened until the operator pressed Reload.
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <>
      <FormSchemas reloadKey={reloadKey} onNew={() => setEditor({})} onSelect={(id) => setEditor({ id })} />
      {editor && (
        // Keyed on the record: picking a different schema without closing the
        // modal must load that schema, not keep the previous one's draft.
        <FormSchemaEditor
          key={editor.id ?? '__new__'}
          {...(editor.id ? { schemaId: editor.id } : {})}
          onSaved={() => {
            setEditor(null);
            setReloadKey((k) => k + 1);
          }}
          onCancel={() => setEditor(null)}
        />
      )}
    </>
  );
}
