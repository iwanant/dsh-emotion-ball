using System;
using System.IO;
using System.Management;
using System.Text;

/*
 * 「重启 DSH」的第一段：把执行体交给 WMI 创建，然后自己退出。
 *
 * 为什么需要这一段，而不是球直接起执行体：
 *   球的任何子进程都会在球退出时被收掉（Electron 用 Job Object 挂子进程，
 *   DSH 被杀 → 球被杀 → 球的孩子一起没）。走一次 WMI，执行体就属于 WmiPrvSE，
 *   球和 DSH 怎么死都牵连不到它。
 *
 * 为什么它是 winexe（GUI 子系统）而不是控制台程序：
 *   控制台程序被 WMI 创建时，Windows 会**分配一个控制台窗口**——用户看到的就是
 *   「点了重启，屏幕上闪一个黑框」。编译成 /target:winexe 后根本没有控制台可闪。
 *   同理，执行体 restart-helper.exe 也是 winexe。
 *
 * 为什么不用 powershell.exe 做这一段：
 *   控制台程序（会闪），而且实测它被 WMI 创建后跑不了脚本——`-File`、
 *   `-EncodedCommand`、`-Command "& 'x.ps1'"` 全部返回 0 却一行都不执行。
 *   自己写 30 行 C#，既没有窗口也没有这个坑，还快了 300 多毫秒。
 */

class RestartLauncher
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

    /** 命令行里的每个值都包一层引号：路径和进程名里有空格也不会断 */
    static string Quote(string value)
    {
        return "\"" + value + "\"";
    }

    static int Main(string[] args)
    {
        string helper = null;
        string image = null;
        string exe = null;
        string log = null;
        int delay = 600;

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--helper": helper = args[++i]; break;
                case "--image": image = args[++i]; break;
                case "--exe": exe = args[++i]; break;
                case "--log": log = args[++i]; break;
                case "--delay": delay = int.Parse(args[++i]); break;
            }
        }

        logPath = string.IsNullOrEmpty(log) ? Path.Combine(Path.GetTempPath(), "dsh-restart.log") : log;
        Note("launcher start");

        if (string.IsNullOrEmpty(helper) || string.IsNullOrEmpty(image) || string.IsNullOrEmpty(exe))
        {
            Note("missing --helper / --image / --exe");
            return 2;
        }

        string commandLine = Quote(helper)
            + " --image " + Quote(image)
            + " --exe " + Quote(exe)
            + " --log " + Quote(logPath)
            + " --delay " + delay.ToString();

        try
        {
            using (ManagementClass processClass = new ManagementClass("Win32_Process"))
            using (ManagementBaseObject inParams = processClass.GetMethodParameters("Create"))
            {
                inParams["CommandLine"] = commandLine;
                using (ManagementBaseObject outParams = processClass.InvokeMethod("Create", inParams, null))
                {
                    object code = outParams["ReturnValue"];
                    object pid = outParams["ProcessId"];
                    Note("wmi return=" + (code == null ? "?" : code.ToString())
                        + " pid=" + (pid == null ? "?" : pid.ToString()));
                    return code == null ? 0 : Convert.ToInt32(code);
                }
            }
        }
        catch (Exception error)
        {
            Note("wmi failed: " + error.Message);
            return 1;
        }
    }
}
