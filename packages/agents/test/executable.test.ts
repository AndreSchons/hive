import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommand, unixSearchPath, windowsSearchPath } from '../src/claude/executable';

describe('resolveCommand', () => {
  it('fora do Windows, sem achar, usa o nome como veio', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hive-empty-'));
    expect(resolveCommand('claude', 'linux', empty)).toEqual({ file: 'claude', args: [] });
  });

  it('no Linux acha o instalador nativo fora do PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const exe = join(home, '.local', 'bin', 'claude');
    writeFileSync(exe, '');
    chmodSync(exe, 0o755);
    const searchPath = unixSearchPath({ PATH: '', HOME: home });
    expect(resolveCommand('claude', 'linux', searchPath)).toEqual({ file: exe, args: [] });
  });

  it('no Linux ignora arquivo sem permissao de execucao', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-noexec-'));
    writeFileSync(join(dir, 'claude'), '');
    chmodSync(join(dir, 'claude'), 0o644);
    expect(resolveCommand('claude', 'linux', dir)).toEqual({ file: 'claude', args: [] });
  });

  it('segue o shim .cmd do npm ate o executavel de verdade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-shim-'));
    // Formato que o npm grava hoje para o Claude Code.
    writeFileSync(
      join(dir, 'claude.cmd'),
      '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    );
    expect(resolveCommand('claude', 'win32', dir)).toEqual({
      file: join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      args: [],
    });
  });

  it('acha o instalador nativo fora do PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'hive-home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const exe = join(home, '.local', 'bin', 'claude.exe');
    writeFileSync(exe, '');
    const searchPath = windowsSearchPath({ PATH: '', USERPROFILE: home });
    expect(resolveCommand('claude', 'win32', searchPath)).toEqual({ file: exe, args: [] });
  });

  it('shim que aponta para script roda pelo node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-shim-'));
    writeFileSync(join(dir, 'claude.cmd'), '"%_prog%"  "%dp0%\\node_modules\\x\\cli.js" %*\r\n');
    expect(resolveCommand('claude', 'win32', dir)).toEqual({
      file: 'node',
      args: [join(dir, 'node_modules', 'x', 'cli.js')],
    });
  });
});
