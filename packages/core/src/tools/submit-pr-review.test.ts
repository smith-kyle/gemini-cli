/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubmitPrReviewTool } from './submit-pr-review.js';
import type { SubmitPrReviewParams } from './submit-pr-review.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import {
  createMockMessageBus,
  getMockMessageBusInstance,
} from '../test-utils/mock-message-bus.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

// Track the last spawned process for test assertions
let lastSpawnCall: {
  command: string;
  args: string[];
  stdinData: string;
} | null = null;

let mockSpawnBehavior: 'success' | 'failure' | 'error' = 'success';
let mockStdout = '';
let mockStderr = '';
let mockExitCode = 0;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { default: EventEmitter } = await import('node:events');
  const { Readable, Writable } = await import('node:stream');
  type ChildProcess = import('node:child_process').ChildProcess;

  return {
    ...actual,
    spawn: vi.fn(
      (command: string, args: string[], _options: Record<string, unknown>) => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new Readable({ read() {} });
        const stderr = new Readable({ read() {} });
        child.stdout = stdout;
        child.stderr = stderr;

        // Capture stdin data
        let stdinData = '';
        child.stdin = new Writable({
          write(chunk: Buffer, _encoding: string, callback: () => void) {
            stdinData += chunk.toString();
            callback();
          },
          final(callback: () => void) {
            lastSpawnCall = { command, args, stdinData };
            callback();
          },
        });

        child.kill = vi.fn();

        // Simulate behavior async
        process.nextTick(() => {
          if (mockSpawnBehavior === 'error') {
            child.emit('error', new Error('spawn ENOENT'));
            return;
          }

          if (mockStdout) {
            stdout.push(mockStdout);
          }
          stdout.push(null);

          if (mockStderr) {
            stderr.push(mockStderr);
          }
          stderr.push(null);

          child.emit(
            'close',
            mockSpawnBehavior === 'failure' ? mockExitCode || 1 : 0,
          );
        });

        return child;
      },
    ),
  };
});

describe('SubmitPrReviewTool', () => {
  let mockConfig: Config;
  let bus: MessageBus;
  let tool: SubmitPrReviewTool;

  const validParams: SubmitPrReviewParams = {
    owner: 'google',
    repo: 'gemini-cli',
    prNumber: 42,
    body: 'Looks good overall with a few suggestions.',
    event: 'COMMENT',
    comments: [
      {
        path: 'src/foo.ts',
        line: 10,
        body: 'Consider using a const here.',
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    lastSpawnCall = null;
    mockSpawnBehavior = 'success';
    mockStdout = '';
    mockStderr = '';
    mockExitCode = 0;

    bus = createMockMessageBus();
    getMockMessageBusInstance(bus).defaultToolDecision = 'ask_user';
    mockConfig = {} as Config;
    tool = new SubmitPrReviewTool(mockConfig, bus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parameter validation', () => {
    it('should reject empty owner', () => {
      const params = { ...validParams, owner: '' };
      const error = tool.validateToolParams(params);
      expect(error).toContain('owner');
    });

    it('should reject empty repo', () => {
      const params = { ...validParams, repo: '' };
      const error = tool.validateToolParams(params);
      expect(error).toContain('repo');
    });

    it('should reject empty body', () => {
      const params = { ...validParams, body: '' };
      const error = tool.validateToolParams(params);
      expect(error).toContain('body');
    });

    it('should reject negative prNumber', () => {
      const params = { ...validParams, prNumber: -1 };
      const error = tool.validateToolParams(params);
      expect(error).toContain('prNumber');
    });

    it('should reject zero prNumber', () => {
      const params = { ...validParams, prNumber: 0 };
      const error = tool.validateToolParams(params);
      expect(error).toContain('prNumber');
    });

    it('should reject non-integer prNumber', () => {
      const params = { ...validParams, prNumber: 1.5 };
      const error = tool.validateToolParams(params);
      expect(error).toContain('prNumber');
    });

    it('should reject invalid event value', () => {
      const params = { ...validParams, event: 'INVALID' as 'COMMENT' };
      const error = tool.validateToolParams(params);
      expect(error).toContain('event');
    });

    it('should reject comment with empty path', () => {
      const params = {
        ...validParams,
        comments: [{ path: '', line: 10, body: 'comment' }],
      };
      const error = tool.validateToolParams(params);
      expect(error).toContain('path');
    });

    it('should reject comment with invalid line', () => {
      const params = {
        ...validParams,
        comments: [{ path: 'src/foo.ts', line: 0, body: 'comment' }],
      };
      const error = tool.validateToolParams(params);
      expect(error).toContain('line');
    });

    it('should reject comment with empty body', () => {
      const params = {
        ...validParams,
        comments: [{ path: 'src/foo.ts', line: 10, body: '' }],
      };
      const error = tool.validateToolParams(params);
      expect(error).toContain('body');
    });

    it('should accept valid params', () => {
      const error = tool.validateToolParams(validParams);
      expect(error).toBeNull();
    });

    it('should accept valid params without comments', () => {
      const { comments: _, ...paramsNoComments } = validParams;
      const error = tool.validateToolParams(
        paramsNoComments as SubmitPrReviewParams,
      );
      expect(error).toBeNull();
    });
  });

  describe('confirmation UI', () => {
    it('should return info-type confirmation details', async () => {
      const invocation = tool.build(validParams);
      const abortController = new AbortController();
      const details = await invocation.shouldConfirmExecute(
        abortController.signal,
      );

      expect(details).not.toBe(false);
      if (details !== false) {
        expect(details.type).toBe('info');
        expect(details.title).toBe('Submit PR Review');
        expect('prompt' in details && details.prompt).toContain(
          'google/gemini-cli#42',
        );
        expect('prompt' in details && details.prompt).toContain('COMMENT');
        expect('prompt' in details && details.prompt).toContain(
          'Looks good overall',
        );
        expect('prompt' in details && details.prompt).toContain('src/foo.ts');
      }
    });
  });

  describe('execution', () => {
    it('should successfully submit a review', async () => {
      mockSpawnBehavior = 'success';
      mockStdout = '{"id": 123}';

      const invocation = tool.build(validParams);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Successfully submitted');
      expect(result.llmContent).toContain('google/gemini-cli#42');
      expect(result.error).toBeUndefined();
    });

    it('should return error on non-zero exit code', async () => {
      mockSpawnBehavior = 'failure';
      mockStderr = 'Not Found';

      const invocation = tool.build(validParams);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Error');
      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    });

    it('should return error when gh is not installed', async () => {
      mockSpawnBehavior = 'error';

      const invocation = tool.build(validParams);
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Error');
      expect(result.llmContent).toContain('spawn ENOENT');
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    });

    it('should pass correct gh api args', async () => {
      mockSpawnBehavior = 'success';

      const invocation = tool.build(validParams);
      await invocation.execute(new AbortController().signal);

      expect(lastSpawnCall).not.toBeNull();
      expect(lastSpawnCall!.command).toBe('gh');
      expect(lastSpawnCall!.args).toEqual([
        'api',
        'repos/google/gemini-cli/pulls/42/reviews',
        '-X',
        'POST',
        '--input',
        '-',
      ]);
    });

    it('should pipe correct JSON payload to stdin', async () => {
      mockSpawnBehavior = 'success';

      const invocation = tool.build(validParams);
      await invocation.execute(new AbortController().signal);

      expect(lastSpawnCall).not.toBeNull();
      const payload = JSON.parse(lastSpawnCall!.stdinData);
      expect(payload.body).toBe('Looks good overall with a few suggestions.');
      expect(payload.event).toBe('COMMENT');
      expect(payload.comments).toHaveLength(1);
      expect(payload.comments[0].path).toBe('src/foo.ts');
      expect(payload.comments[0].line).toBe(10);
    });

    it('should omit comments array when no comments provided', async () => {
      mockSpawnBehavior = 'success';
      const { comments: _, ...paramsNoComments } = validParams;

      const invocation = tool.build(paramsNoComments as SubmitPrReviewParams);
      await invocation.execute(new AbortController().signal);

      expect(lastSpawnCall).not.toBeNull();
      const payload = JSON.parse(lastSpawnCall!.stdinData);
      expect(payload.comments).toBeUndefined();
    });
  });

  describe('getDescription', () => {
    it('should return human-readable string with PR ref and comment count', () => {
      const invocation = tool.build(validParams);
      const description = invocation.getDescription();

      expect(description).toBe(
        'Submitting review to google/gemini-cli#42 (COMMENT) with 1 inline comment',
      );
    });

    it('should use plural for multiple comments', () => {
      const params = {
        ...validParams,
        comments: [
          { path: 'a.ts', line: 1, body: 'x' },
          { path: 'b.ts', line: 2, body: 'y' },
        ],
      };
      const invocation = tool.build(params);
      expect(invocation.getDescription()).toContain('2 inline comments');
    });

    it('should handle zero comments', () => {
      const { comments: _, ...paramsNoComments } = validParams;
      const invocation = tool.build(paramsNoComments as SubmitPrReviewParams);
      expect(invocation.getDescription()).toContain('0 inline comments');
    });
  });
});
