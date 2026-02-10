# Submit PR Review tool (`submit_pr_review`)

This document describes the `submit_pr_review` tool for the Gemini CLI.

## Description

Use `submit_pr_review` to submit a review to a GitHub pull request, including an
overall summary and optional inline comments on specific lines of code. This
tool is used by the `/review` command to post reviews after analyzing a PR.

### Arguments

`submit_pr_review` takes the following arguments:

- `owner` (string, required): The owner of the repository (e.g. `"google"`).
- `repo` (string, required): The repository name (e.g. `"gemini-cli"`).
- `prNumber` (integer, required): The pull request number.
- `body` (string, required): A concise summary of the review covering key
  findings.
- `event` (string, required): The review action. One of `"COMMENT"`,
  `"APPROVE"`, or `"REQUEST_CHANGES"`.
- `comments` (array, optional): Inline comments on specific lines of changed
  files. Each comment has:
  - `path` (string, required): The relative path to the file.
  - `line` (integer, required): The line number in the new version of the file.
  - `body` (string, required): The review comment for that line.
  - `start_line` (integer, optional): Start line for multi-line comments.

## Confirmation flow

Because this tool posts a review to GitHub (a mutating action), it requires user
confirmation before executing. The confirmation prompt shows:

- The PR reference (owner/repo#number)
- The review event type
- A summary of the review body
- A list of inline comments with file paths and line numbers

## Prerequisites

- The GitHub CLI (`gh`) must be installed and authenticated. The tool uses
  `gh api` under the hood to submit the review.

## How it works

The tool constructs a JSON payload matching the
[GitHub Create a review API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)
and pipes it to `gh api` via stdin. This avoids shell escaping issues that can
occur when passing JSON through command-line arguments.
