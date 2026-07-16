import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { db } from '../lib/firestoreAdmin';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

type TemplateDoc = {
  subject?: string;
  body?: string;
  html?: string | null;
  title?: string;
  description?: string | null;
  tags?: string[];
  category?: string | null;
  updatedAtMs?: number;
};

export async function listTemplatesHandler(
  req: CallableRequest<unknown>,
): Promise<{ templates: Array<Record<string, unknown>> }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const snap = await db().collection('emailTemplates').get();
  const templates = snap.docs.map((d) => {
    const data = d.data() as TemplateDoc;
    return {
      templateId: d.id,
      subject: data.subject ?? '',
      body: data.body ?? '',
      html: data.html ?? null,
      title: data.title ?? d.id,
      description: data.description ?? null,
      tags: data.tags ?? [],
      category: data.category ?? null,
    };
  });
  return { templates };
}

export async function listTemplateBindingsHandler(
  req: CallableRequest<unknown>,
): Promise<{ bindings: Array<Record<string, unknown>> }> {
  initSentry();
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const snap = await db().collection('notificationTemplateBindings').get();
  const bindings = snap.docs.map((d) => {
    const data = d.data() as {
      templateId?: string;
      audience?: string | null;
      triggerKey?: string | null;
      active?: boolean;
    };
    return {
      catalogKey: d.id,
      templateId: data.templateId ?? '',
      audience: data.audience ?? null,
      triggerKey: data.triggerKey ?? null,
      active: data.active ?? false,
    };
  });
  return { bindings };
}

export const listTemplates = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listTemplates', listTemplatesHandler),
);

export const listTemplateBindings = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('listTemplateBindings', listTemplateBindingsHandler),
);
