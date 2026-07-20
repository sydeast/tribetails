import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listTemplates, listTemplatesPage, listTemplateCategories } from './templates';

beforeEach(() => call.mockReset());

describe('templates api', () => {
  it('listTemplates unwraps the { templates } envelope and calls the right callable with no args', async () => {
    const templates = [
      {
        templateId: 'booking.confirmed',
        subject: 'Your booking is confirmed',
        body: 'Hi {{kinfolk_name}}',
        html: null,
        title: 'Booking Confirmed',
        description: null,
        tags: ['booking'],
        category: 'Booking',
      },
    ];
    call.mockResolvedValue({ templates });
    const result = await listTemplates();
    expect(call).toHaveBeenCalledWith('listTemplates', {});
    expect(result).toEqual(templates);
  });

  it('defaults to [] when the callable returns no templates', async () => {
    call.mockResolvedValue({});
    expect(await listTemplates()).toEqual([]);
  });

  it('preserves null html/description/category rather than coercing them', async () => {
    call.mockResolvedValue({
      templates: [
        {
          templateId: 'x',
          subject: 'S',
          body: 'B',
          html: null,
          title: 'X',
          description: null,
          tags: [],
          category: null,
        },
      ],
    });
    const result = await listTemplates();
    expect(result[0]?.html).toBeNull();
    expect(result[0]?.description).toBeNull();
    expect(result[0]?.category).toBeNull();
  });

  it('listTemplatesPage calls listTemplates with the paging args and unwraps { templates, nextCursor }', async () => {
    call.mockResolvedValue({ templates: [{ templateId: 'a' }], nextCursor: 'a' });
    const result = await listTemplatesPage({ limit: 50 });
    expect(call).toHaveBeenCalledWith('listTemplates', { limit: 50 });
    expect(result).toEqual({ templates: [{ templateId: 'a' }], nextCursor: 'a' });
  });

  it('listTemplatesPage forwards a startAfter cursor when paging forward', async () => {
    call.mockResolvedValue({ templates: [], nextCursor: null });
    await listTemplatesPage({ limit: 50, startAfter: 'b' });
    expect(call).toHaveBeenCalledWith('listTemplates', { limit: 50, startAfter: 'b' });
  });

  it('listTemplatesPage defaults templates to [] and nextCursor to null when the callable omits them', async () => {
    call.mockResolvedValue({});
    expect(await listTemplatesPage({ limit: 50 })).toEqual({ templates: [], nextCursor: null });
  });

  it('listTemplateCategories unwraps the { categories } envelope and calls the right callable', async () => {
    call.mockResolvedValue({ categories: ['Booking', 'Reminder'], schemaVersion: 1 });
    const result = await listTemplateCategories();
    expect(call).toHaveBeenCalledWith('listCategories', {});
    expect(result).toEqual(['Booking', 'Reminder']);
  });

  it('defaults to [] when the callable returns no categories', async () => {
    call.mockResolvedValue({ schemaVersion: 1 });
    expect(await listTemplateCategories()).toEqual([]);
  });
});
