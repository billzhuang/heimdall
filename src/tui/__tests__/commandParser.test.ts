import { describe, it, expect } from 'vitest';
import { parseCommand, isSlashCommand, isQuickCheck, isQuery, getSlashCommands } from '../commandParser.js';

describe('commandParser', () => {
  describe('slash commands', () => {
    it('should parse /ctx as context command', () => {
      const result = parseCommand('/ctx');
      expect(result).toEqual({ type: 'ctx' });
    });

    it('should parse /ns as namespace command', () => {
      const result = parseCommand('/ns');
      expect(result).toEqual({ type: 'ns' });
    });

    it('should parse /model as model command', () => {
      const result = parseCommand('/model');
      expect(result).toEqual({ type: 'model' });
    });

    it('should parse /help as help command', () => {
      const result = parseCommand('/help');
      expect(result).toEqual({ type: 'help' });
    });

    it('should parse /exit as exit command', () => {
      const result = parseCommand('/exit');
      expect(result).toEqual({ type: 'exit' });
    });

    it('should parse /quit as exit command', () => {
      const result = parseCommand('/quit');
      expect(result).toEqual({ type: 'exit' });
    });

    it('should parse /clear as clear command', () => {
      const result = parseCommand('/clear');
      expect(result).toEqual({ type: 'clear' });
    });

    it('should parse /new as new command', () => {
      const result = parseCommand('/new');
      expect(result).toEqual({ type: 'new' });
    });

    it('should parse /compact as compact command', () => {
      const result = parseCommand('/compact');
      expect(result).toEqual({ type: 'compact' });
    });

    it('should handle slash commands with trailing text', () => {
      const result = parseCommand('/ctx some extra text');
      expect(result).toEqual({ type: 'ctx' });
    });

    it('should return unknown for invalid slash commands', () => {
      const result = parseCommand('/invalid');
      expect(result).toEqual({ type: 'unknown', raw: '/invalid' });
    });

    it('should be case insensitive for slash commands', () => {
      expect(parseCommand('/CTX')).toEqual({ type: 'ctx' });
      expect(parseCommand('/Ns')).toEqual({ type: 'ns' });
    });
  });

  describe('control commands', () => {
    it('should parse "help" as help command', () => {
      expect(parseCommand('help')).toEqual({ type: 'help' });
    });

    it('should parse "?" as help command', () => {
      expect(parseCommand('?')).toEqual({ type: 'help' });
    });

    it('should parse "h" as help command', () => {
      expect(parseCommand('h')).toEqual({ type: 'help' });
    });

    it('should parse "exit" as exit command', () => {
      expect(parseCommand('exit')).toEqual({ type: 'exit' });
    });

    it('should parse "quit" as exit command', () => {
      expect(parseCommand('quit')).toEqual({ type: 'exit' });
    });

    it('should parse "q" as exit command', () => {
      expect(parseCommand('q')).toEqual({ type: 'exit' });
    });
  });

  describe('quick check commands', () => {
    it('should parse "run check" as smoke quick check', () => {
      const result = parseCommand('run check');
      expect(result).toEqual({ type: 'quickCheck', mode: 'smoke', model: undefined });
    });

    it('should parse "quick check" as smoke mode', () => {
      const result = parseCommand('quick check');
      expect(result).toEqual({ type: 'quickCheck', mode: 'smoke', model: undefined });
    });

    it('should parse "comprehensive check" as all mode', () => {
      const result = parseCommand('comprehensive check');
      expect(result).toEqual({ type: 'quickCheck', mode: 'all', model: undefined });
    });

    it('should parse "full check" as all mode', () => {
      const result = parseCommand('full check');
      expect(result).toEqual({ type: 'quickCheck', mode: 'all', model: undefined });
    });

    it('should extract model from check command', () => {
      const result = parseCommand('run check with opus');
      expect(result).toEqual({ type: 'quickCheck', mode: 'smoke', model: 'opus' });
    });

    it('should extract haiku model', () => {
      const result = parseCommand('quick check haiku');
      expect(result).toEqual({ type: 'quickCheck', mode: 'smoke', model: 'haiku' });
    });

    it('should handle comprehensive check with model', () => {
      const result = parseCommand('comprehensive check with sonnet');
      expect(result).toEqual({ type: 'quickCheck', mode: 'all', model: 'sonnet' });
    });
  });

  describe('general queries', () => {
    it('should parse general text as query', () => {
      const result = parseCommand('show me pods in crashloop');
      expect(result).toEqual({ type: 'query', text: 'show me pods in crashloop', model: undefined });
    });

    it('should extract model from query', () => {
      const result = parseCommand('use opus to show my deployments');
      expect(result).toEqual({ type: 'query', text: 'use opus to show my deployments', model: 'opus' });
    });

    it('should preserve original text in query', () => {
      const result = parseCommand('  What is wrong with my ingress?  ');
      expect(result.type).toBe('query');
      if (result.type === 'query') {
        expect(result.text).toBe('What is wrong with my ingress?');
      }
    });
  });

  describe('edge cases', () => {
    it('should return unknown for empty input', () => {
      expect(parseCommand('')).toEqual({ type: 'unknown', raw: '' });
    });

    it('should return unknown for whitespace only', () => {
      expect(parseCommand('   ')).toEqual({ type: 'unknown', raw: '   ' });
    });

    it('should handle input with leading/trailing whitespace', () => {
      expect(parseCommand('  /ctx  ')).toEqual({ type: 'ctx' });
    });
  });

  describe('helper functions', () => {
    it('isSlashCommand should identify slash commands', () => {
      expect(isSlashCommand(parseCommand('/ctx'))).toBe(true);
      expect(isSlashCommand(parseCommand('/help'))).toBe(true);
      expect(isSlashCommand(parseCommand('help'))).toBe(true);
      expect(isSlashCommand(parseCommand('run check'))).toBe(false);
    });

    it('isQuickCheck should identify quick check commands', () => {
      expect(isQuickCheck(parseCommand('run check'))).toBe(true);
      expect(isQuickCheck(parseCommand('/ctx'))).toBe(false);
    });

    it('isQuery should identify general queries', () => {
      expect(isQuery(parseCommand('show pods'))).toBe(true);
      expect(isQuery(parseCommand('/ctx'))).toBe(false);
    });

    it('getSlashCommands should return all slash commands', () => {
      const commands = getSlashCommands();
      expect(commands).toContain('/ctx');
      expect(commands).toContain('/ns');
      expect(commands).toContain('/model');
      expect(commands).toContain('/help');
      expect(commands).toContain('/exit');
      expect(commands).toContain('/quit');
      expect(commands).toContain('/clear');
      expect(commands).toContain('/new');
      expect(commands).toContain('/compact');
    });
  });
});
