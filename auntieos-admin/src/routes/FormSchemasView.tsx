import { useState } from 'react';
import { FormSchemas } from '../screens/FormSchemas';
import { FormSchemaEditor } from '../screens/FormSchemaEditor';

/** List and editor in one route: `null` is the list, a value is the editor. */
export function FormSchemasView() {
  const [editor, setEditor] = useState<{ id?: string } | null>(null);
  if (editor) {
    return (
      <FormSchemaEditor
        {...(editor.id ? { schemaId: editor.id } : {})}
        onSaved={() => setEditor(null)}
        onCancel={() => setEditor(null)}
      />
    );
  }
  return <FormSchemas onNew={() => setEditor({})} onSelect={(id) => setEditor({ id })} />;
}
