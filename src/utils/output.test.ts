import { describe, expect, it } from 'vitest';
import { CellOutput, formatOutputsAsMarkdown } from './output';

describe('formatOutputsAsMarkdown', () => {
  it('formats text output with code block', () => {
    const outputs: CellOutput[] = [
      { type: 'text', text: 'Hello, World!' }
    ];
    
    const result = formatOutputsAsMarkdown(outputs);
    
    expect(result).toBe('```\nHello, World!\n```');
  });

  it('formats error output with name and message', () => {
    const outputs: CellOutput[] = [
      { type: 'error', name: 'TypeError', message: 'undefined is not a function', stack: '' }
    ];
    
    const result = formatOutputsAsMarkdown(outputs);
    
    expect(result).toBe('**Error**: TypeError: undefined is not a function');
  });

  it('formats error output with stack trace', () => {
    const outputs: CellOutput[] = [
      { 
        type: 'error', 
        name: 'ValueError', 
        message: 'invalid value', 
        stack: 'at line 1\nat line 2' 
      }
    ];
    
    const result = formatOutputsAsMarkdown(outputs);
    
    expect(result).toContain('**Error**: ValueError: invalid value');
    expect(result).toContain('```\nat line 1\nat line 2\n```');
  });

  it('formats image output as placeholder', () => {
    const outputs: CellOutput[] = [
      { type: 'image', data: 'base64data', mimeType: 'image/png' }
    ];
    
    const result = formatOutputsAsMarkdown(outputs);
    
    expect(result).toBe('[Image output: image/png]');
  });

  it('formats rich json and html outputs', () => {
    const outputs: CellOutput[] = [
      { type: 'json', data: { x: 1 }, mimeType: 'application/json' },
      { type: 'html', html: '<b>ok</b>', mimeType: 'text/html' }
    ];

    const result = formatOutputsAsMarkdown(outputs);

    expect(result).toContain('```json\n{\n  "x": 1\n}\n```');
    expect(result).toContain('```html\n<b>ok</b>\n```');
  });

  it('handles multiple outputs', () => {
    const outputs: CellOutput[] = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ];
    
    const result = formatOutputsAsMarkdown(outputs);
    
    expect(result).toBe('```\nfirst\n```\n```\nsecond\n```');
  });

  it('returns empty string for no outputs', () => {
    const result = formatOutputsAsMarkdown([]);
    
    expect(result).toBe('');
  });
});
