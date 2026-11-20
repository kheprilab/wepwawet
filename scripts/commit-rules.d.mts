export interface PullRequestCommit {
  sha: string;
  message: string;
}

export interface PullRequestInput {
  author: string;
  body: string | null | undefined;
  commits: PullRequestCommit[];
}

export function findAttribution(text: string | null | undefined): string[];
export function checkCommitMessage(message: string): string[];
export function checkPullRequest(input: PullRequestInput): string[];
