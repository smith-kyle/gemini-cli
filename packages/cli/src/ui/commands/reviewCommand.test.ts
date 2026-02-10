/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnAsync } from '@google/gemini-cli-core';
import { reviewCommand } from './reviewCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import type { SubmitPromptActionReturn } from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    spawnAsync: vi.fn(),
    debugLogger: { debug: vi.fn() },
  };
});

const mockSpawnAsync = vi.mocked(spawnAsync);

describe('reviewCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return error when args are empty', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    const result = await reviewCommand.action(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Please provide a PR reference. Usage: /review <url>, /review owner/repo#123, or /review 123',
    });
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });

  it('should return error when args are only whitespace', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    const result = await reviewCommand.action(mockContext, '   ');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Please provide a PR reference. Usage: /review <url>, /review owner/repo#123, or /review 123',
    });
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });

  it('should return error for unparseable PR reference', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    const result = await reviewCommand.action(mockContext, 'not-a-valid-ref');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Could not parse PR reference. Supported formats:\n  - https://github.com/owner/repo/pull/123\n  - owner/repo#123\n  - 123 (when inside the repo directory)',
    });
    expect(mockSpawnAsync).not.toHaveBeenCalled();
  });

  it('should fetch PR and return submit_prompt for full GitHub URL', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    const prMetadata = JSON.stringify({
      title: 'Test PR',
      body: 'Description',
      headRefName: 'feature-branch',
    });
    mockSpawnAsync
      .mockResolvedValueOnce({ stdout: prMetadata, stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/foo b/foo', stderr: '' });

    const result = (await reviewCommand.action(
      mockContext,
      'https://github.com/owner/repo/pull/42',
    )) as SubmitPromptActionReturn;

    expect(result.type).toBe('submit_prompt');
    expect(typeof result.content).toBe('string');
    const content = result.content as string;
    expect(content).toContain('pull request #42');
    expect(content).toContain('owner/repo');
    expect(content).toContain('IMPORTANT: You are reviewing remotely');
    expect(content).toContain('Do NOT use file tools');
    expect(content).toContain('-R owner/repo');
    expect(content).toContain('feature-branch');
    expect(content).toContain(prMetadata);
    expect(content).toContain('diff --git a/foo b/foo');
    expect(content).toContain('submit_pr_review');
    expect(content).toContain('`owner`: "owner"');
    expect(content).toContain('`repo`: "repo"');
    expect(content).toContain('`prNumber`: 42');

    expect(mockSpawnAsync).toHaveBeenCalledTimes(2);
    expect(mockSpawnAsync).toHaveBeenCalledWith('gh', [
      'pr',
      'view',
      '42',
      '-R',
      'owner/repo',
      '--json',
      'title,body,author,baseRefName,headRefName,files',
    ]);
    expect(mockSpawnAsync).toHaveBeenCalledWith('gh', [
      'pr',
      'diff',
      '42',
      '-R',
      'owner/repo',
    ]);
  });

  it('should fetch PR and return submit_prompt for owner/repo#123 shorthand', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    const prMetadata = JSON.stringify({
      title: 'Shorthand PR',
      headRefName: 'main',
    });
    mockSpawnAsync
      .mockResolvedValueOnce({ stdout: prMetadata, stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff content', stderr: '' });

    const result = (await reviewCommand.action(
      mockContext,
      'some-owner/some-repo#99',
    )) as SubmitPromptActionReturn;

    expect(result.type).toBe('submit_prompt');
    const content = result.content as string;
    expect(content).toContain('pull request #99');
    expect(content).toContain('some-owner/some-repo');
    expect(content).toContain('submit_pr_review');
    expect(content).toContain('`owner`: "some-owner"');
    expect(content).toContain('`repo`: "some-repo"');
    expect(content).toContain('`prNumber`: 99');

    expect(mockSpawnAsync).toHaveBeenCalledWith('gh', [
      'pr',
      'view',
      '99',
      '-R',
      'some-owner/some-repo',
      '--json',
      'title,body,author,baseRefName,headRefName,files',
    ]);
  });

  it('should return error when bare PR number and detectCurrentRepo fails', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    mockSpawnAsync.mockRejectedValueOnce(new Error('not a git repo'));

    const result = await reviewCommand.action(mockContext, '7');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Could not parse PR reference. Supported formats:\n  - https://github.com/owner/repo/pull/123\n  - owner/repo#123\n  - 123 (when inside the repo directory)',
    });
    expect(mockSpawnAsync).toHaveBeenCalledTimes(1);
    expect(mockSpawnAsync).toHaveBeenCalledWith('gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ]);
  });

  it('should fetch PR when bare number and detectCurrentRepo succeeds', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    const prMetadata = JSON.stringify({
      title: 'Bare',
      headRefName: 'branch',
    });
    mockSpawnAsync
      .mockResolvedValueOnce({ stdout: 'my-org/my-repo', stderr: '' })
      .mockResolvedValueOnce({ stdout: prMetadata, stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff', stderr: '' });

    const result = (await reviewCommand.action(
      mockContext,
      '5',
    )) as SubmitPromptActionReturn;

    expect(result.type).toBe('submit_prompt');
    const content = result.content as string;
    expect(content).toContain('pull request #5');
    expect(content).toContain('my-org/my-repo');

    expect(mockSpawnAsync).toHaveBeenCalledTimes(3);
    expect(mockSpawnAsync).toHaveBeenNthCalledWith(1, 'gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ]);
    expect(mockSpawnAsync).toHaveBeenNthCalledWith(2, 'gh', [
      'pr',
      'view',
      '5',
      '-R',
      'my-org/my-repo',
      '--json',
      'title,body,author,baseRefName,headRefName,files',
    ]);
  });

  it('should return error when gh pr view fails', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    mockSpawnAsync
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ title: 'x', headRefName: 'y' }),
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('gh: PR not found'));

    const result = await reviewCommand.action(
      mockContext,
      'https://github.com/o/r/pull/1',
    );

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
    expect((result as { content: string }).content).toContain(
      'Failed to fetch PR data',
    );
    expect((result as { content: string }).content).toContain(
      'gh: PR not found',
    );
  });

  it('should use HEAD when PR metadata JSON has no headRefName', async () => {
    if (!reviewCommand.action) throw new Error('Command has no action');

    mockSpawnAsync
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'diff', stderr: '' });

    const result = (await reviewCommand.action(
      mockContext,
      'https://github.com/a/b/pull/1',
    )) as SubmitPromptActionReturn;

    const content = result.content as string;
    expect(content).toContain('?ref=HEAD');
  });
});
