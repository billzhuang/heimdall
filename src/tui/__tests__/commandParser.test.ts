import { describe, it, expect } from 'vitest';
import { parseCommand, isSlashCommand, isQuery, getSlashCommands } from '../commandParser.js';

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

    it('should parse /continue as continue command', () => {
      const result = parseCommand('/continue');
      expect(result).toEqual({ type: 'continue' });
    });

    it('should parse /sessions as sessions command', () => {
      const result = parseCommand('/sessions');
      expect(result).toEqual({ type: 'sessions' });
    });

    it('should parse /resume with query', () => {
      const result = parseCommand('/resume 1');
      expect(result).toEqual({ type: 'resume', query: '1' });
    });

    it('should parse /resume with session ID', () => {
      const result = parseCommand('/resume abc123');
      expect(result).toEqual({ type: 'resume', query: 'abc123' });
    });

    it('should parse /resume without query', () => {
      const result = parseCommand('/resume');
      expect(result).toEqual({ type: 'resume' });
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

  describe('general queries (all go to LLM)', () => {
    it('should parse general text as query', () => {
      const result = parseCommand('show me pods in crashloop');
      expect(result).toEqual({ type: 'query', text: 'show me pods in crashloop', model: undefined });
    });

    it('should parse "check pdb" as query', () => {
      const result = parseCommand('check pdb');
      expect(result).toEqual({ type: 'query', text: 'check pdb', model: undefined });
    });

    it('should parse "health check" as query', () => {
      const result = parseCommand('health check');
      expect(result).toEqual({ type: 'query', text: 'health check', model: undefined });
    });

    it('should parse "run check" as query', () => {
      const result = parseCommand('run check');
      expect(result).toEqual({ type: 'query', text: 'run check', model: undefined });
    });

    it('should parse "comprehensive check" as query', () => {
      const result = parseCommand('comprehensive check');
      expect(result).toEqual({ type: 'query', text: 'comprehensive check', model: undefined });
    });

    it('should parse "check ingress configuration" as query', () => {
      const result = parseCommand('check ingress configuration');
      expect(result).toEqual({ type: 'query', text: 'check ingress configuration', model: undefined });
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
      expect(isSlashCommand(parseCommand('check pdb'))).toBe(false);
    });

    it('isQuery should identify general queries', () => {
      expect(isQuery(parseCommand('show pods'))).toBe(true);
      expect(isQuery(parseCommand('check pdb'))).toBe(true);
      expect(isQuery(parseCommand('health check'))).toBe(true);
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
      expect(commands).toContain('/continue');
      expect(commands).toContain('/sessions');
      expect(commands).toContain('/resume');
    });
  });
});
