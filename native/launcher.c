/*
 * Svara Dev bundle launcher.
 *
 * The previous launcher was a `#!/bin/sh` script that `exec`'d the sovereign
 * Python. A shell script carries no Mach-O code directory, so once the image
 * was replaced by unsigned conda python3.13 macOS resolved the running
 * process to a path-based identity (`…/bin/python3.13`) instead of the
 * bundle's `ai.svara.dev`. The microphone grant therefore never applied:
 * coreaudiod logged "Client is not granted access to the input device" and
 * the recorder captured pure silence (peak 0, RMS 0.0) with no error raised,
 * which surfaced as "No audio reached Svara" followed by "No speech detected".
 *
 * This binary IS the bundle's CFBundleExecutable, so it is signed as part of
 * `ai.svara.dev`. It spawns Python as a *child* rather than exec'ing it: a
 * child inherits its parent's responsible process, so the microphone request
 * is attributed to the bundle and System Settings shows a single Svara entry
 * instead of separate "Svara" and "python" rows.
 *
 * Build: scripts/build-dev-app.sh compiles this straight into
 * `dist/Svara Dev.app/Contents/MacOS/SvaraDev`. There is deliberately no
 * checked-in binary; a copy under assets/bin/ would go stale silently.
 */

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef SVARA_REPO
#define SVARA_REPO "/Volumes/personal/programmingFolders/nadabodha"
#endif

#ifndef SVARA_PYTHON
#define SVARA_PYTHON "/Volumes/personal/conda_envs/sovereign/bin/python3"
#endif

static pid_t child = -1;

/* Relay termination signals so Ctrl-C / quit reach Python, not just the shell. */
static void forward_signal(int sig)
{
    if (child > 0) {
        kill(child, sig);
    }
}

int main(int argc, char **argv)
{
    const char *repo = getenv("SVARA_REPO");
    const char *python = getenv("SVARA_PYTHON");

    if (repo == NULL || *repo == '\0') {
        repo = SVARA_REPO;
    }
    if (python == NULL || *python == '\0') {
        python = SVARA_PYTHON;
    }

    if (chdir(repo) != 0) {
        fprintf(stderr, "Svara Dev: cannot enter %s: %s\n", repo, strerror(errno));
        return 1;
    }

    child = fork();
    if (child < 0) {
        fprintf(stderr, "Svara Dev: fork failed: %s\n", strerror(errno));
        return 1;
    }

    if (child == 0) {
        /* argv: <python> -m svara <original args excluding argv[0]> */
        char **args = calloc((size_t)argc + 3, sizeof *args);
        if (args == NULL) {
            _exit(127);
        }
        args[0] = (char *)python;
        args[1] = (char *)"-m";
        args[2] = (char *)"svara";
        for (int i = 1; i < argc; i++) {
            args[i + 2] = argv[i];
        }
        args[argc + 2] = NULL;

        execv(python, args);
        fprintf(stderr, "Svara Dev: cannot exec %s: %s\n", python, strerror(errno));
        _exit(127);
    }

    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = forward_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGHUP, &action, NULL);

    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR) {
            fprintf(stderr, "Svara Dev: waitpid failed: %s\n", strerror(errno));
            return 1;
        }
    }

    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        int sig = WTERMSIG(status);
        signal(sig, SIG_DFL);
        raise(sig);
        return 128 + sig;
    }
    return 0;
}
