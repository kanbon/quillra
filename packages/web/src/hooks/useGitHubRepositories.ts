import { useCurrentUser } from "@/hooks/useCurrentUser";
import { apiJson } from "@/lib/api";
import {
  type GitHubConnection,
  type GithubRepoRow,
  githubConnectUrl,
  isGitHubConnectionRequired,
} from "@/lib/github";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export function useGitHubRepositories(enabled = true) {
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const userId =
    currentUser.kind === "github" || currentUser.kind === "team" ? currentUser.user.id : null;
  const queryEnabled = enabled && !!userId;

  const connectionQ = useQuery({
    queryKey: ["github-connection", userId],
    queryFn: () => apiJson<GitHubConnection>("/api/github/connection"),
    enabled: queryEnabled,
    retry: false,
  });

  const reposQ = useQuery({
    queryKey: ["github-repos", userId],
    queryFn: () => apiJson<{ repos: GithubRepoRow[] }>("/api/github/repos"),
    enabled: queryEnabled && connectionQ.data?.connected !== false,
    retry: false,
  });

  const disconnect = useMutation({
    mutationFn: () => apiJson<void>("/api/github/connection", { method: "DELETE" }),
    onSuccess: async () => {
      queryClient.setQueryData<GitHubConnection>(["github-connection", userId], {
        connected: false,
      });
      queryClient.removeQueries({ queryKey: ["github-repos", userId] });
      await queryClient.invalidateQueries({ queryKey: ["github-connection", userId] });
    },
  });

  const connectionRequired =
    connectionQ.data?.connected === false ||
    isGitHubConnectionRequired(connectionQ.error) ||
    isGitHubConnectionRequired(reposQ.error);

  return {
    userId,
    connectionQ,
    reposQ,
    disconnect,
    connectionRequired,
    connectUrl: githubConnectUrl(reposQ.error ?? connectionQ.error),
  };
}
