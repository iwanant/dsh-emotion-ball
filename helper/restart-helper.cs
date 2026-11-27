using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

/*
 * 「重启 DSH」的执行体：等一会 → 杀光同名进程 → 等它们真的消失 → 重新拉起。
 *
 * 为什么不是 PowerShell：
 *   1. 这个进程必须活到「重新拉起」之后，而球的任何子进程都会在球退出时被收掉
 *      （Electron 把子进程挂在 Job Object 上，DSH 被杀 → 球被杀 → 球的孩子一起没）。
 *      所以它由 PowerShell 通过 WMI 创建，脱离球的进程树。
 *   2. 但实测 PowerShell **被 WMI 创建后跑不了脚本**（`-File`、`-EncodedCommand`、
 *      `-Command "& 'x.ps1'"` 全部返回 0 却一行都不执行，只有极短的内联命令能跑）。
 *      C# 小 exe 没有这个问题。
 *
 * 顺序不能改：
 *   1. 先等 delay —— 让球退干净、让 launcher 走完；
 *   2. 杀掉所有同名进程 —— 卡死时往往是一整窝（主进程 + 渲染 + GPU），只杀一个
 *      剩下的会接管窗口，看起来像没重启；
 *   3. 等进程真的消失（最多 15s），再兜底强杀一次 —— DSH 有单实例锁，旧进程没死透
 *      时拉起新的，新进程只会去「聚焦」那个正在咽气的窗口，用户会以为没反应；
 *   4. 最后才重新拉起。
 */
class RestartHelper
{
    static string logPath;

    static void Note(string message)
    {
        try
        {
            File.AppendAllText(logPath, DateTime.Now.ToString("s") + " " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch
        {
            /* 日志写不进去也不能影响重启本身 */
        }
    }

    static int Main(string[] args)
    {
        string image = null;
        string exe = null;
        string log = null;
        int delay = 600;

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--image": image = args[++i]; break;
                case "--exe": exe = args[++i]; break;
                case "--log": log = args[++i]; break;
                case "--delay": delay = int.Parse(args[++i]); break;
            }
        }

        logPath = string.IsNullOrEmpty(log) ? Path.Combine(Path.GetTempPath(), "dsh-restart.log") : log;
        Note("restart requested");
        if (string.IsNullOrEmpty(image) || string.IsNullOrEmpty(exe))
        {
            Note("missing --image or --exe");
            return 2;
        }

        Thread.Sleep(delay < 0 ? 0 : delay);

        Process[] before = null;
        try
        {
            before = Process.GetProcessesByName(image);
        }
        catch (Exception error)
        {
            Note("enumerate failed: " + error.Message);
        }
        Note("running before kill: " + (before == null ? 0 : before.Length));
        if (before != null)
        {
            foreach (Process item in before)
            {
                try
                {
                    item.Kill();
                }
                catch
                {
                    try { Note("kill failed: " + item.Id); } catch { }
                }
            }
        }

        bool gone = false;
        for (int i = 0; i < 150; i++)
        {
            Thread.Sleep(100);
            try
            {
                if (Process.GetProcessesByName(image).Length == 0)
                {
                    gone = true;
                    break;
                }
            }
            catch
            {
                gone = true;
                break;
            }
        }
        if (!gone)
        {
            Note("still alive after 15s, sweeping again");
            try
            {
                foreach (Process item in Process.GetProcessesByName(image))
                {
                    try { item.Kill(); } catch { }
                }
            }
            catch { }
            Thread.Sleep(800);
        }
        Note("killed");

        Thread.Sleep(400);
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(exe);
            info.UseShellExecute = false;
            info.WorkingDirectory = Path.GetDirectoryName(exe);
            Process started = Process.Start(info);
            Note("relaunched pid " + (started == null ? "?" : started.Id.ToString()));
        }
        catch (Exception error)
        {
            Note("relaunch failed: " + error.Message);
        }
        return 0;
    }
}
