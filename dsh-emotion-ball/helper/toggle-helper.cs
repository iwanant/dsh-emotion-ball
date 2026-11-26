/*
 * dsh-emotion-ball 的窗口控制器（Windows 专用）。
 *
 * 为什么不是 PowerShell：冷启动一个带 Add-Type 的 PowerShell 要 1.3 秒、常驻 70MB+，
 * 双击球的时候就是「按下去一秒才动」。这个 exe 由系统自带的 csc.exe 现场编译，
 * 冷启动约 130ms、常驻约 12MB，行为一样但基本感觉不到延迟。
 *
 * 协议（和 dsh-toggle-loop.ps1 一致：stdin 收命令，stdout 回一行）：
 *   ready           启动完成
 *   focus           回 focus=0 / focus=1（DSH 是不是前台窗口）
 *   toggle          可见且没被遮挡 → 最小化；否则 → 还原并置前，回 ok minimize / ok raise
 *   show            还原并置前，回 ok raise
 *   ok none         找不到 DSH 窗口（顺手把它拉起来）
 */

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ToggleHelper
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr param);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;
    private const uint GA_ROOT = 2;
    private const uint GW_OWNER = 4;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const byte VK_MENU = 0x12;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const string DSH_IMAGE = "DeepSeek Harness.exe";

    private static IntPtr cachedWindow = IntPtr.Zero;
    private static string dshExecutable;

    /// <summary>进程名 + MainWindowHandle 在这台机器上不可靠（Electron 多进程），改成枚举顶层窗口按 exe 名匹配。</summary>
    private static string ImageNameOf(uint processId)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (handle == IntPtr.Zero) return string.Empty;
        try
        {
            var buffer = new StringBuilder(1024);
            uint size = 1024;
            return QueryFullProcessImageName(handle, 0, buffer, ref size) ? Path.GetFileName(buffer.ToString()) : string.Empty;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    private static IntPtr ResolveWindow()
    {
        if (cachedWindow != IntPtr.Zero && IsWindow(cachedWindow)) return cachedWindow;
        cachedWindow = IntPtr.Zero;
        try
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows((window, _) =>
            {
                if (!IsWindowVisible(window)) return true;
                if (GetWindow(window, GW_OWNER) != IntPtr.Zero) return true;
                if (GetWindowTextLength(window) == 0) return true;
                uint pid;
                GetWindowThreadProcessId(window, out pid);
                if (!string.Equals(ImageNameOf(pid), DSH_IMAGE, StringComparison.OrdinalIgnoreCase)) return true;
                found = window;
                return false;
            }, IntPtr.Zero);
            cachedWindow = found;
        }
        catch
        {
            /* 枚举失败就当没找到 */
        }
        return cachedWindow;
    }

    /// <summary>窗口中心点是否真的属于 DSH：被别的窗口盖住时返回 true。</summary>
    private static bool IsCovered(IntPtr window)
    {
        if (IsIconic(window)) return false;
        RECT rect;
        if (!GetWindowRect(window, out rect)) return false;
        if (rect.Right <= rect.Left || rect.Bottom <= rect.Top) return false;
        var center = new POINT
        {
            X = (rect.Left + rect.Right) / 2,
            Y = (rect.Top + rect.Bottom) / 2,
        };
        return GetAncestor(WindowFromPoint(center), GA_ROOT) != window;
    }

    private static void Raise(IntPtr window)
    {
        ShowWindow(window, SW_RESTORE);
        if (GetForegroundWindow() == window) return;
        /* 注意：csc.exe（.NET Framework 4.x 自带）只支持 C# 5，别用 out 变量内联声明这类新语法 */
        uint foregroundPid;
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
        uint mine = GetCurrentThreadId();
        if (foregroundThread != 0) AttachThreadInput(mine, foregroundThread, true);
        BringWindowToTop(window);
        SetForegroundWindow(window);
        if (foregroundThread != 0) AttachThreadInput(mine, foregroundThread, false);
        if (GetForegroundWindow() == window) return;
        /* 系统拒绝抢前台时，按一下 Alt 让它认为我们在「用户操作」 */
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        SetForegroundWindow(window);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    private static void Main(string[] args)
    {
        if (args.Length > 0) dshExecutable = args[0];
        /* 先报 ready，让宿主尽早进入可用状态；解析窗口放到第一条命令时再做 */
        Console.Out.WriteLine("ready");
        Console.Out.Flush();

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string command = line.Trim();
            if (command != "toggle" && command != "focus" && command != "show") continue;

            IntPtr window = ResolveWindow();
            if (command == "focus")
            {
                bool focused = window != IntPtr.Zero && window == GetForegroundWindow();
                Console.Out.WriteLine("focus=" + (focused ? "1" : "0"));
                Console.Out.Flush();
                continue;
            }

            if (window == IntPtr.Zero)
            {
                if (!string.IsNullOrEmpty(dshExecutable))
                {
                    try { Process.Start(dshExecutable); } catch { /* 拉不起来就算了 */ }
                }
                Console.Out.WriteLine("ok none");
                Console.Out.Flush();
                continue;
            }

            /* 只有在「看得见、没被盖住」时才收起；被盖住或已经最小化，双击的意图都是「把它弄到最前」。 */
            bool shown = IsWindowVisible(window) && !IsIconic(window);
            if (command == "toggle" && shown && !IsCovered(window))
            {
                ShowWindow(window, SW_MINIMIZE);
                Console.Out.WriteLine("ok minimize");
            }
            else
            {
                Raise(window);
                Console.Out.WriteLine("ok raise");
            }
            Console.Out.Flush();
        }
    }
}
