using System.Diagnostics;
using System.Net.Http;

const string DefaultUrl = "http://localhost:7700";
const int StartupTimeoutSeconds = 25;
const string RepoRootFileName = "vaultflow.repo-root.txt";

var dashboardUrl = GetArgValue(args, "--url") ?? Environment.GetEnvironmentVariable("VAULTFLOW_DASHBOARD_URL") ?? DefaultUrl;
var installDir = AppContext.BaseDirectory;
var repoRoot = GetArgValue(args, "--repo")
    ?? Environment.GetEnvironmentVariable("VAULTFLOW_REPO_ROOT")
    ?? ReadRepoRootFromInstall(installDir);

if (string.IsNullOrWhiteSpace(repoRoot) || !IsVaultFlowRepo(repoRoot))
{
    ShowError($"""
VaultFlow repo not found.

Launcher install: {installDir}

Expected repo root file: {Path.Combine(installDir, RepoRootFileName)}
""");
    return;
}

if (!await IsDashboardReachableAsync(dashboardUrl))
{
    StartDashboardServer(repoRoot);
    if (!await WaitForDashboardAsync(dashboardUrl, TimeSpan.FromSeconds(StartupTimeoutSeconds)))
    {
        ShowError($"Dashboard server did not start in time.\n\nRepo: {repoRoot}\nURL: {dashboardUrl}");
        return;
    }
}

OpenBrowser(dashboardUrl);

static string? GetArgValue(string[] args, string name)
{
    for (var i = 0; i < args.Length - 1; i++)
    {
        if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
        {
            return args[i + 1];
        }
    }
    return null;
}

static string? ReadRepoRootFromInstall(string installDir)
{
    var manifestPath = Path.Combine(installDir, RepoRootFileName);
    if (!File.Exists(manifestPath))
    {
        return null;
    }

    try
    {
        var repoRoot = File.ReadAllText(manifestPath).Trim();
        return string.IsNullOrWhiteSpace(repoRoot) ? null : repoRoot;
    }
    catch
    {
        return null;
    }
}

static bool IsVaultFlowRepo(string path)
{
    return File.Exists(Path.Combine(path, "package.json")) &&
           File.Exists(Path.Combine(path, ".claude", "helpers", "dashboard", "server.mjs"));
}

static async Task<bool> WaitForDashboardAsync(string dashboardUrl, TimeSpan timeout)
{
    var started = DateTime.UtcNow;
    while (DateTime.UtcNow - started < timeout)
    {
        if (await IsDashboardReachableAsync(dashboardUrl)) return true;
        await Task.Delay(750);
    }
    return false;
}

static async Task<bool> IsDashboardReachableAsync(string dashboardUrl)
{
    using var client = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(3),
    };

    try
    {
        var response = await client.GetAsync($"{dashboardUrl.TrimEnd('/')}/api/status");
        return response.IsSuccessStatusCode;
    }
    catch
    {
        return false;
    }
}

static void StartDashboardServer(string repoRoot)
{
    var logDir = Path.Combine(repoRoot, ".claude", "helpers", "dashboard");
    Directory.CreateDirectory(logDir);

    var logPath = Path.Combine(logDir, "dashboard-launcher.log");
    var errPath = Path.Combine(logDir, "dashboard-launcher.err.log");

    var psi = new ProcessStartInfo
    {
        FileName = "cmd.exe",
        Arguments = "/d /c npm run dashboard:serve",
        WorkingDirectory = repoRoot,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        WindowStyle = ProcessWindowStyle.Hidden,
    };

    var process = new Process
    {
        StartInfo = psi,
        EnableRaisingEvents = true,
    };

    process.OutputDataReceived += (_, e) =>
    {
        if (!string.IsNullOrWhiteSpace(e.Data))
        {
            File.AppendAllText(logPath, e.Data + Environment.NewLine);
        }
    };

    process.ErrorDataReceived += (_, e) =>
    {
        if (!string.IsNullOrWhiteSpace(e.Data))
        {
            File.AppendAllText(errPath, e.Data + Environment.NewLine);
        }
    };

    if (!process.Start())
    {
        throw new InvalidOperationException("Failed to start dashboard server process.");
    }

    process.BeginOutputReadLine();
    process.BeginErrorReadLine();
}

static void OpenBrowser(string dashboardUrl)
{
    Process.Start(new ProcessStartInfo
    {
        FileName = dashboardUrl,
        UseShellExecute = true,
    });
}

static void ShowError(string message)
{
    try
    {
        System.Windows.Forms.MessageBox.Show(
            message,
            "VaultFlow Dashboard Launcher",
            System.Windows.Forms.MessageBoxButtons.OK,
            System.Windows.Forms.MessageBoxIcon.Error
        );
    }
    catch
    {
    }
}
