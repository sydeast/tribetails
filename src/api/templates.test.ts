import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listTemplates, listTemplateCategories } from './templates';

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
