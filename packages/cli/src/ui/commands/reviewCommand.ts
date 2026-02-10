/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger, spawnAsync } from '@google/gemini-cli-core';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

interface PrRef {
  owner: string;
  repo: string;
  prNumber: string;
}

const EMPTY_ARGS_MESSAGE =
  'Please provide a PR reference. Usage: /review <url>, /review owner/repo#123, or /review 123';

const PARSE_ERROR_MESSAGE =
  'Could not parse PR reference. Supported formats:\n  - https://github.com/owner/repo/pull/123\n  - owner/repo#123\n  - 123 (when inside the repo directory)';

const parsePrReference = async (args: string): Promise<PrRef | null> => {
  const trimmed = args.trim();
  // Try to match full URL
  // e.g. https://github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (urlMatch)
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: urlMatch[3],
    };

  // Try to match shorthand format
  // e.g. owner/repo#123
  const shorthandMatch = trimmed.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shorthandMatch)
    return {
      owner: shorthandMatch[1],
      repo: shorthandMatch[2],
      prNumber: shorthandMatch[3],
    };

  // Try to match bare PR number
  // e.g. 123
  if (/^\d+$/.test(trimmed)) {
    const detected = await detectCurrentRepo();
    if (detected) return { ...detected, prNumber: trimmed };
  }
  return null;
};

const detectCurrentRepo = async (): Promise<PrRef | null> => {
  try {
    const { stdout } = await spawnAsync('gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ]);
    const parts = stdout.trim().split('/');
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1], prNumber: '' };
  } catch {
    return null;
  }
};

const getHeadRefFromMetadata = (stdout: string): string => {
  try {
    const meta = JSON.parse(stdout) as { headRefName?: string };
    return meta.headRefName ?? 'HEAD';
  } catch {
    return 'HEAD';
  }
};

const buildReviewPrompt = (
  owner: string,
  repo: string,
  prNumber: string,
  headRefName: string,
  prMetadata: string,
  diff: string,
): string => {
  const repoFlag = `${owner}/${repo}`;
  return `You are reviewing pull request #${prNumber} on ${owner}/${repo}.

## IMPORTANT: You are reviewing remotely

You are NOT inside the repository directory. Do NOT use file tools (ReadFile, SearchText, ListDirectory, Glob) to read the codebase — they would read the wrong place or fail.

To get additional file contents when the diff is not enough, use the Shell tool with \`gh\` only. Always pass \`-R ${repoFlag}\` so the command targets this repo from any directory.

- To read a file from the PR branch:
  \`gh api repos/${owner}/${repo}/contents/<filepath>?ref=${headRefName} -q .content | base64 -d\`
  (Replace <filepath> with the path, e.g. \`src/foo.ts\`.)

- To list directory contents (if needed):
  \`gh api repos/${owner}/${repo}/contents/<dirpath>?ref=${headRefName}\`

All GitHub operations must use \`gh\` with \`-R ${repoFlag}\`.

## PR Metadata
\`\`\`
${prMetadata}
\`\`\`

## Diff
\`\`\`diff
${diff}
\`\`\`

## Instructions

Please review this pull request thoroughly. Focus on:
1. **Correctness**: Does the code achieve its stated purpose without bugs or logical errors?
2. **Maintainability**: Is the code clean, well-structured, and easy to understand?
3. **Security**: Are there any potential security vulnerabilities?
4. **Edge Cases**: Does the code handle edge cases and errors appropriately?
5. **Tests**: Is the new or modified code adequately covered by tests?

After your analysis, post a GitHub PR review with inline comments using the following steps:

1. For each finding that refers to a specific line or range of code, create an inline comment.
   The line numbers must refer to the new version of the file (the right side of the diff).
   Only comment on lines that are part of the diff -- do not comment on unchanged lines.

2. Construct a JSON payload. The payload must have:
   - \`body\`: A concise summary of the review covering the key findings.
   - \`event\`: "COMMENT" (neutral review status).
   - \`comments\`: An array of inline comment objects, one per finding:
     - \`path\`: The relative path to the changed file.
     - \`line\`: The line number in the new version of the file.
     - \`body\`: The specific review comment for that line.
     For multi-line comments, include \`start_line\` to mark the beginning of the range.

3. Post the review using a file (do not pass JSON through the shell — quoting will break):
   - Use the WriteFile tool to write the JSON payload to a file (e.g. \`review_payload.json\`).
   - Then run: \`gh api repos/${owner}/${repo}/pulls/${prNumber}/reviews --input review_payload.json -X POST\`
   This avoids shell escaping issues with quotes and newlines in the payload.

Begin your review now.`;
};

const err = (content: string): SlashCommandActionReturn => ({
  type: 'message',
  messageType: 'error',
  content,
});

const fetchAndBuildPrompt = async (
  ref: PrRef,
): Promise<SlashCommandActionReturn> => {
  const repoFlag = `${ref.owner}/${ref.repo}`;
  const prNumber = ref.prNumber;
  try {
    const [metadataResult, diffResult] = await Promise.all([
      spawnAsync('gh', [
        'pr',
        'view',
        prNumber,
        '-R',
        repoFlag,
        '--json',
        'title,body,author,baseRefName,headRefName,files',
      ]),
      spawnAsync('gh', ['pr', 'diff', prNumber, '-R', repoFlag]),
    ]);
    const headRefName = getHeadRefFromMetadata(metadataResult.stdout);
    const prompt = buildReviewPrompt(
      ref.owner,
      ref.repo,
      prNumber,
      headRefName,
      metadataResult.stdout,
      diffResult.stdout,
    );
    return { type: 'submit_prompt', content: prompt };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.debug(`/review command failed: ${message}`);
    return err(
      `Failed to fetch PR data. Make sure \`gh\` is installed and authenticated.\n\nError: ${message}`,
    );
  }
};

export const reviewCommand: SlashCommand = {
  name: 'review',
  description: 'Review a pull request',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (
    _context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();
    if (!trimmedArgs) return err(EMPTY_ARGS_MESSAGE);

    const prRef = await parsePrReference(trimmedArgs);
    if (prRef) return fetchAndBuildPrompt(prRef);

    return err(PARSE_ERROR_MESSAGE);
  },
};
