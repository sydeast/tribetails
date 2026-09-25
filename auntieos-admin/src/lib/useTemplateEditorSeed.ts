import { useCallback, useMemo, useState } from 'react';
import type { TemplateSummary } from '../api/templates';
import { templateEditorMode, type TemplateEditorMode } from './templateFormat';
import { editorCanRoundTrip } from './emailRoundTrip';

export interface TemplateEditorSeed {
  /** Which editor the screen shows. */
  mode: TemplateEditorMode;
  /**
   * What the content editor mounts with. `key` changes only when the content
   * is replaced wholesale, which remounts the editor. `content` is the
   * baseline every save check compares against: after a Convert the loaded
   * row still holds the old content, so the row cannot be the baseline.
   */
  seed: { key: number; content: string };
  /**
   * Ruling C5(a): the seed is content the editor cannot write back as it
   * found it, so the body is locked and Save sends the seed untouched.
   * Worked out once per seed, because it runs a headless editor.
   */
  bodyLocked: boolean;
  /**
   * Replaces the content wholesale (Task 10's Convert): a new seed, a fresh
   * editor, the lock check run again, and the mode switched (visual unless
   * told otherwise). The caller also puts the content into its form state.
   */
  reseed: (content: string, mode?: TemplateEditorMode) => void;
}

/** #953: the template editor's mode and content seed, read from the row at open. */
export function useTemplateEditorSeed(template: Pick<TemplateSummary, 'format' | 'content'> | null): TemplateEditorSeed {
  const [mode, setMode] = useState<TemplateEditorMode>(() => templateEditorMode(template));
  const [seed, setSeed] = useState(() => ({ key: 0, content: template?.content ?? '' }));
  const bodyLocked = useMemo(
    () => mode === 'visual' && seed.content !== '' && !editorCanRoundTrip(seed.content),
    [mode, seed.content],
  );
  const reseed = useCallback((content: string, next: TemplateEditorMode = 'visual') => {
    setSeed((prev) => ({ key: prev.key + 1, content }));
    setMode(next);
  }, []);
  return { mode, seed, bodyLocked, reseed };
}
