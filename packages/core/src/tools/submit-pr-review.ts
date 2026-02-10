/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { spawn } from 'node:child_process';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,

  ToolConfirmationOutcome} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind
} from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { debugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';
import { SUBMIT_PR_REVIEW_TOOL_NAME } from './tool-names.js';

/**
 * Parameters for the SubmitPrReview tool
 */
export interface SubmitPrReviewParams {
  /**
   * The owner of the repository (e.g. "google")
   */
  owner: string;

  /**
   * The repository name (e.g. "gemini-cli")
   */
  repo: string;

  /**
   * The pull request number
   */
  prNumber: number;

  /**
   * A concise summary of the review covering key findings
   */
  body: string;

  /**
   * The review action: COMMENT, APPROVE, or REQUEST_CHANGES
   */
  event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

  /**
   * Optional array of inline comments on specific lines of changed files
   */
  comments?: Array<{
    path: string;
    line: number;
    body: string;
    start_line?: number;
  }>;
}

/**
 * Spawns a process and pipes data to its stdin.
 * Resolves with { stdout, stderr } on success; rejects on non-zero exit or spawn error.
 */
function spawnWithStdin(
  command: string,
  args: string[],
  stdinData: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const abortHandler = () => {
      child.kill();
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', abortHandler);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `gh command failed with exit code ${code}:\n${stderr || stdout}`,
          ),
        );
      }
    });

    child.on('error', (err) => {
      signal?.removeEventListener('abort', abortHandler);
      reject(err);
    });

    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

class SubmitPrReviewToolInvocation extends BaseToolInvocation<
  SubmitPrReviewParams,
  ToolResult
> {
  constructor(
    params: SubmitPrReviewParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const commentCount = this.params.comments?.length ?? 0;
    return `Submitting review to ${this.params.owner}/${this.params.repo}#${this.params.prNumber} (${this.params.event}) with ${commentCount} inline comment${commentCount === 1 ? '' : 's'}`;
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const { owner, repo, prNumber, event, body, comments } = this.params;
    const commentSummary =
      comments && comments.length > 0
        ? comments
            .map((c) => {
              const lineRef = c.start_line ? `${c.start_line}-` : '';
              const preview =
                c.body.length > 80 ? c.body.substring(0, 77) + '...' : c.body;
              return `  - ${c.path}:${lineRef}${c.line}: ${preview}`;
            })
            .join('\n')
        : '  (none)';

    const bodyPreview =
      body.length > 200 ? body.substring(0, 197) + '...' : body;
    const prompt = `PR: ${owner}/${repo}#${prNumber}
Event: ${event}
Body: ${bodyPreview}
Inline comments:
${commentSummary}`;

    return {
      type: 'info',
      title: `Submit PR Review`,
      prompt,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        await this.publishPolicyUpdate(outcome);
      },
    };
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const { owner, repo, prNumber, event, body, comments } = this.params;

    const payload: Record<string, unknown> = { body, event };
    if (comments && comments.length > 0) {
      payload['comments'] = comments;
    }

    const jsonPayload = JSON.stringify(payload);
    const apiPath = `repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

    try {
      const { stdout } = await spawnWithStdin(
        'gh',
        ['api', apiPath, '-X', 'POST', '--input', '-'],
        jsonPayload,
        signal,
      );

      const llmSuffix = stdout ? `\nAPI response: ${stdout}` : '';
      return {
        llmContent: `Successfully submitted ${event} review to ${owner}/${repo}#${prNumber}.${llmSuffix}`,
        returnDisplay: `Review submitted to ${owner}/${repo}#${prNumber}`,
      };
    } catch (error) {
      debugLogger.warn(`SubmitPrReview execute Error`, error);
      const errorMessage = `Failed to submit PR review: ${getErrorMessage(error)}`;
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

/**
 * Implementation of the SubmitPrReview tool logic
 */
export class SubmitPrReviewTool extends BaseDeclarativeTool<
  SubmitPrReviewParams,
  ToolResult
> {
  static readonly Name = SUBMIT_PR_REVIEW_TOOL_NAME;

  constructor(_config: Config, messageBus: MessageBus) {
    super(
      SubmitPrReviewTool.Name,
      'SubmitPrReview',
      'Submits a review to a GitHub pull request with optional inline comments. Requires the GitHub CLI (gh) to be installed and authenticated.',
      Kind.Execute,
      {
        properties: {
          owner: {
            description: 'The owner of the repository (e.g. "google").',
            type: 'string',
          },
          repo: {
            description: 'The repository name (e.g. "gemini-cli").',
            type: 'string',
          },
          prNumber: {
            description: 'The pull request number.',
            type: 'integer',
          },
          body: {
            description:
              'A concise summary of the review covering key findings.',
            type: 'string',
          },
          event: {
            description:
              'The review action: "COMMENT" for neutral feedback, "APPROVE" to approve, or "REQUEST_CHANGES" to request changes.',
            type: 'string',
            enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
          },
          comments: {
            description:
              'Optional array of inline comments on specific lines of changed files.',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: {
                  description:
                    'The relative path to the file being commented on.',
                  type: 'string',
                },
                line: {
                  description:
                    'The line number in the new version of the file.',
                  type: 'integer',
                },
                body: {
                  description: 'The review comment for this line or range.',
                  type: 'string',
                },
                start_line: {
                  description:
                    'Optional start line for multi-line comments. When provided, "line" becomes the end of the range.',
                  type: 'integer',
                },
              },
              required: ['path', 'line', 'body'],
            },
          },
        },
        required: ['owner', 'repo', 'prNumber', 'body', 'event'],
        type: 'object',
      },
      messageBus,
      false,
      false,
    );
  }

  /**
   * Validates the parameters for the tool.
   */
  protected override validateToolParamValues(
    params: SubmitPrReviewParams,
  ): string | null {
    if (!params.owner || params.owner.trim() === '') {
      return "The 'owner' parameter cannot be empty.";
    }
    if (!params.repo || params.repo.trim() === '') {
      return "The 'repo' parameter cannot be empty.";
    }
    if (!params.body || params.body.trim() === '') {
      return "The 'body' parameter cannot be empty.";
    }
    if (!Number.isInteger(params.prNumber) || params.prNumber <= 0) {
      return "The 'prNumber' parameter must be a positive integer.";
    }
    if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(params.event)) {
      return "The 'event' parameter must be one of: COMMENT, APPROVE, REQUEST_CHANGES.";
    }

    if (params.comments) {
      for (let i = 0; i < params.comments.length; i++) {
        const comment = params.comments[i];
        if (!comment.path || comment.path.trim() === '') {
          return `Comment at index ${i} has an empty 'path'.`;
        }
        if (!Number.isInteger(comment.line) || comment.line <= 0) {
          return `Comment at index ${i} has an invalid 'line' (must be a positive integer).`;
        }
        if (!comment.body || comment.body.trim() === '') {
          return `Comment at index ${i} has an empty 'body'.`;
        }
      }
    }

    return null;
  }

  protected createInvocation(
    params: SubmitPrReviewParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<SubmitPrReviewParams, ToolResult> {
    return new SubmitPrReviewToolInvocation(
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
