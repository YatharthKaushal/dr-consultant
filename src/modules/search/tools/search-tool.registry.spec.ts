import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { TOOL_ERROR_CODES } from './search-tool.constants';
import type { AgentTool } from './search-tool.contract';
import { ToolRegistry } from './search-tool.registry';

function fakeTool(name: string, schema = z.object({ a: z.string() })): AgentTool<{ a: string }, unknown> {
  return {
    name,
    description: `description for ${name}`,
    inputSchema: schema,
    execute: jest.fn().mockResolvedValue({ ok: name }),
  };
}

describe('ToolRegistry', () => {
  it('lists every registered tool in registration order', () => {
    const registry = new ToolRegistry([fakeTool('alpha'), fakeTool('beta')]);
    expect(registry.listNames()).toEqual(['alpha', 'beta']);
    expect(registry.list()).toHaveLength(2);
  });

  it('is empty when nothing is registered', () => {
    expect(new ToolRegistry([]).list()).toEqual([]);
  });

  it('resolves a tool by name', () => {
    const alpha = fakeTool('alpha');
    expect(new ToolRegistry([alpha]).resolve('alpha')).toBe(alpha);
  });

  it('reports membership via has()', () => {
    const registry = new ToolRegistry([fakeTool('alpha')]);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });

  it('find() returns null for an unknown name rather than throwing', () => {
    expect(new ToolRegistry([fakeTool('alpha')]).find('nope')).toBeNull();
  });

  describe('unknown tool name', () => {
    it('resolve() throws TOOL_NOT_FOUND', () => {
      const registry = new ToolRegistry([fakeTool('alpha')]);
      expect(() => registry.resolve('nope')).toThrow(NotFoundException);
    });

    it('carries the TOOL_NOT_FOUND code in the error body', () => {
      const registry = new ToolRegistry([fakeTool('alpha')]);
      try {
        registry.resolve('nope');
        fail('expected resolve to throw');
      } catch (error) {
        expect((error as NotFoundException).getResponse()).toMatchObject({ code: TOOL_ERROR_CODES.TOOL_NOT_FOUND });
      }
    });

    it('execute() rejects for an unknown name', async () => {
      const registry = new ToolRegistry([fakeTool('alpha')]);
      await expect(registry.execute('nope', {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('refuses to construct with two tools sharing a name', () => {
    expect(() => new ToolRegistry([fakeTool('alpha'), fakeTool('alpha')])).toThrow(/Duplicate agent tool name/);
  });

  describe('execute', () => {
    it('validates input against the tool schema and passes the parsed value through', async () => {
      const alpha = fakeTool('alpha');
      await new ToolRegistry([alpha]).execute('alpha', { a: 'hello' });
      expect(alpha.execute).toHaveBeenCalledWith({ a: 'hello' });
    });

    it('rejects input failing the schema with a clean TOOL_INPUT_INVALID error', async () => {
      const alpha = fakeTool('alpha');
      const registry = new ToolRegistry([alpha]);

      await expect(registry.execute('alpha', { a: 42 })).rejects.toBeInstanceOf(BadRequestException);
      expect(alpha.execute).not.toHaveBeenCalled();
    });

    it('names the offending field in the message', async () => {
      const registry = new ToolRegistry([fakeTool('alpha')]);
      try {
        await registry.execute('alpha', { a: 42 });
        fail('expected execute to throw');
      } catch (error) {
        const body = (error as BadRequestException).getResponse() as { code: string; message: string };
        expect(body.code).toBe(TOOL_ERROR_CODES.TOOL_INPUT_INVALID);
        expect(body.message).toContain('a:');
      }
    });

    it('rejects a missing required field', async () => {
      const registry = new ToolRegistry([fakeTool('alpha')]);
      await expect(registry.execute('alpha', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns whatever the tool returned', async () => {
      const registry = new ToolRegistry([fakeTool('alpha')]);
      await expect(registry.execute('alpha', { a: 'x' })).resolves.toEqual({ ok: 'alpha' });
    });
  });
});
