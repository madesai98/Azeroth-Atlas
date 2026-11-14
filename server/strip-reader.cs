// Reads one thin row of pixels from the top-left corner of the game window and prints it, so
// the map server can decode the strip the ForeverMapLink addon draws there.
//
// Two ways of looking, both of them plain picture capture:
//   window  the game window's own picture, through the Windows capture API that streaming and
//           screen-sharing programs use (Windows.Graphics.Capture). It does not matter what is
//           in front of the game or where the window is, only that it is not minimized.
//   screen  that spot of the screen, like a screenshot. Used when window capture is not
//           available, and stops working while another window covers the game's corner.
// Neither opens, reads or modifies the game process, and no input is sent to it.
//
// Built automatically by server/tracker.js with the C# compiler that ships with Windows (the
// WGC symbol is defined when the Windows capture API can be compiled in).
// Output lines:  "S <status...>"  when the status changes,  "P <rgb hex>"  when the pixels change.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
#if WGC
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
#endif

static class StripReader
{
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);

    static string lastStatus = "";
    static void Status(TextWriter o, string s)
    {
        if (s == lastStatus) return;
        lastStatus = s;
        o.WriteLine(s);
        o.Flush();
    }

    // The game's main window, preferring the install whose path contains `hint`.
    static IntPtr Find(string[] names, string hint)
    {
        IntPtr best = IntPtr.Zero;
        foreach (string name in names)
        {
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try
                {
                    IntPtr h = p.MainWindowHandle;
                    if (h == IntPtr.Zero) continue;
                    if (best == IntPtr.Zero) best = h;
                    if (hint.Length > 0 && p.MainModule.FileName.ToLowerInvariant().Contains(hint)) return h;
                }
                catch { }
                finally { p.Dispose(); }
            }
        }
        return best;
    }

    // The part of the window that is drawn on screen (without the invisible resize borders).
    static RECT VisibleBounds(IntPtr hwnd)
    {
        RECT r;
        if (DwmGetWindowAttribute(hwnd, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, out r, 16) == 0) return r;
        GetWindowRect(hwnd, out r);
        return r;
    }

#if WGC
    // ---- window capture (Windows.Graphics.Capture + Direct3D 11) -----------------------------
    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
        IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
    }
    [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDirect3DDxgiInterfaceAccess
    {
        IntPtr GetInterface([In] ref Guid iid);
    }
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint sdkVersion, out IntPtr device, out int level, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [StructLayout(LayoutKind.Sequential)]
    struct TEXTURE2D_DESC { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
    [StructLayout(LayoutKind.Sequential)] struct MAPPED { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [StructLayout(LayoutKind.Sequential)] struct BOX { public uint Left, Top, Front, Right, Bottom, Back; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture2DFn(IntPtr self, ref TEXTURE2D_DESC desc, IntPtr initialData, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapFn(IntPtr self, IntPtr resource, uint subresource, int mapType, uint flags, out MAPPED mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapFn(IntPtr self, IntPtr resource, uint subresource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyRegionFn(IntPtr self, IntPtr dst, uint dstSub, uint x, uint y, uint z, IntPtr src, uint srcSub, ref BOX box);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDescFn(IntPtr self, out TEXTURE2D_DESC desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetProtectedFn(IntPtr self, int on);

    // Method `slot` of a COM object's interface (Direct3D has no .NET wrapper in the framework).
    static Delegate Method(IntPtr obj, int slot, Type type)
    {
        IntPtr table = Marshal.ReadIntPtr(obj);
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), type);
    }

    sealed class WindowCapture : IDisposable
    {
        public IntPtr Hwnd;
        IntPtr device, context, staging;
        IDirect3DDevice winrtDevice;
        GraphicsCaptureItem item;
        Direct3D11CaptureFramePool pool;
        GraphicsCaptureSession session;
        SizeInt32 size;
        int stagingWidth;
        MapFn map; UnmapFn unmap; CopyRegionFn copyRegion;
        public int FrameWidth, FrameHeight;
        public DateTime LastFrame = DateTime.UtcNow;

        public static WindowCapture Start(IntPtr hwnd, int width, int interval)
        {
            WindowCapture c = new WindowCapture();
            try { c.Open(hwnd, width, interval); return c; }
            catch { c.Dispose(); throw; }
        }

        void Open(IntPtr hwnd, int width, int interval)
        {
            Hwnd = hwnd;
            int level;
            int hr = D3D11CreateDevice(IntPtr.Zero, 1 /* hardware */, IntPtr.Zero, 0x20 /* BGRA */, IntPtr.Zero, 0, 7, out device, out level, out context);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            // The capture system uses the device from its own threads.
            Guid multithread = new Guid("9B7E4E00-342C-4106-A19F-4F2704F689F0");
            IntPtr mt;
            if (Marshal.QueryInterface(context, ref multithread, out mt) == 0)
            {
                ((SetProtectedFn)Method(mt, 5, typeof(SetProtectedFn)))(mt, 1);
                Marshal.Release(mt);
            }
            Guid dxgiDevice = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
            IntPtr dxgi, inspectable;
            hr = Marshal.QueryInterface(device, ref dxgiDevice, out dxgi);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            try
            {
                hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            }
            finally { Marshal.Release(dxgi); }
            try { winrtDevice = (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable); }
            finally { Marshal.Release(inspectable); }

            IGraphicsCaptureItemInterop interop = (IGraphicsCaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
            Guid itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            IntPtr raw = interop.CreateForWindow(hwnd, ref itemId);
            try { item = (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(raw); }
            finally { Marshal.Release(raw); }

            size = item.Size;
            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
            session = pool.CreateCaptureSession(item);
            // No mouse pointer in the picture, and no coloured border drawn around the game.
            try { session.IsCursorCaptureEnabled = false; } catch { }
            try
            {
                Windows.Foundation.IAsyncInfo access = GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless);
                for (int waited = 0; access.Status == Windows.Foundation.AsyncStatus.Started && waited < 3000; waited += 20) Thread.Sleep(20);
            }
            catch { }
            try { session.IsBorderRequired = false; } catch { }
            // The game draws far more often than the strip is looked at. Ask Windows for a picture
            // only that often, instead of a copy of the whole window for every frame the game draws
            // (made on the graphics card the game is busy on). Newer Windows only; found by name so
            // that this still builds where it does not exist.
            try
            {
                System.Reflection.PropertyInfo every = typeof(GraphicsCaptureSession).GetProperty("MinUpdateInterval");
                if (every != null) every.SetValue(session, TimeSpan.FromMilliseconds(Math.Max(20, interval - 10)), null);
            }
            catch { }
            session.StartCapture();

            // A one-row texture the CPU can read, to copy the strip's row into.
            stagingWidth = width;
            TEXTURE2D_DESC d = new TEXTURE2D_DESC();
            d.Width = (uint)width; d.Height = 1; d.MipLevels = 1; d.ArraySize = 1; d.Format = 87 /* B8G8R8A8_UNORM */;
            d.SampleCount = 1; d.Usage = 3 /* staging */; d.CPUAccessFlags = 0x20000 /* read */;
            hr = ((CreateTexture2DFn)Method(device, 5, typeof(CreateTexture2DFn)))(device, ref d, IntPtr.Zero, out staging);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            map = (MapFn)Method(context, 14, typeof(MapFn));
            unmap = (UnmapFn)Method(context, 15, typeof(UnmapFn));
            copyRegion = (CopyRegionFn)Method(context, 46, typeof(CopyRegionFn));
        }

        // Copies `width` pixels (B, G, R, A) of the picture's row `y`, starting at column `x`, into px.
        // Returns 1 when there was a new picture, 0 when the game has not drawn one since last time.
        public int Read(byte[] px, int x, int y, int width)
        {
            Direct3D11CaptureFrame frame = pool.TryGetNextFrame();
            if (frame == null) return 0;
            // Use the newest picture that is waiting, not one from before the last read.
            for (Direct3D11CaptureFrame newer = pool.TryGetNextFrame(); newer != null; newer = pool.TryGetNextFrame())
            {
                frame.Dispose();
                frame = newer;
            }
            try
            {
                SizeInt32 content = frame.ContentSize;
                if (content.Width != size.Width || content.Height != size.Height)
                {
                    // The window was resized: later pictures need a buffer of the new size.
                    size = content;
                    pool.Recreate(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
                }
                Guid textureId = new Guid("6F15AAF2-D208-4E89-9AB4-489535D34F9C");
                IntPtr texture = ((IDirect3DDxgiInterfaceAccess)(object)frame.Surface).GetInterface(ref textureId);
                try
                {
                    TEXTURE2D_DESC d;
                    ((GetDescFn)Method(texture, 10, typeof(GetDescFn)))(texture, out d);
                    FrameWidth = (int)d.Width; FrameHeight = (int)d.Height;
                    Array.Clear(px, 0, px.Length);
                    if (x < 0 || y < 0 || y >= FrameHeight || x >= FrameWidth) return 1;
                    int w = Math.Min(Math.Min(width, stagingWidth), FrameWidth - x);
                    BOX box = new BOX();
                    box.Left = (uint)x; box.Top = (uint)y; box.Front = 0; box.Right = (uint)(x + w); box.Bottom = (uint)(y + 1); box.Back = 1;
                    copyRegion(context, staging, 0, 0, 0, 0, texture, 0, ref box);
                    MAPPED m;
                    int hr = map(context, staging, 0, 1 /* read */, 0, out m);
                    if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                    try { Marshal.Copy(m.Data, px, 0, w * 4); }
                    finally { unmap(context, staging, 0); }
                }
                finally { Marshal.Release(texture); }
                LastFrame = DateTime.UtcNow;
                return 1;
            }
            finally { frame.Dispose(); }
        }

        public void Dispose()
        {
            try { if (session != null) session.Dispose(); } catch { }
            try { if (pool != null) pool.Dispose(); } catch { }
            session = null; pool = null; item = null; winrtDevice = null;
            if (staging != IntPtr.Zero) { Marshal.Release(staging); staging = IntPtr.Zero; }
            if (context != IntPtr.Zero) { Marshal.Release(context); context = IntPtr.Zero; }
            if (device != IntPtr.Zero) { Marshal.Release(device); device = IntPtr.Zero; }
        }
    }
#endif

    static int Main(string[] args)
    {
        if (args.Length < 6)
        {
            Console.Error.WriteLine("usage: strip-reader <processNames> <pathHint|-> <parentPid> <width> <row> <intervalMs> [screenX screenY | screen]");
            return 2;
        }
        // Work in real screen pixels on every monitor, whatever the Windows display scaling is.
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch { try { SetProcessDPIAware(); } catch { } }

        string[] names = args[0].Split(',');
        string hint = args[1] == "-" ? "" : args[1].ToLowerInvariant();
        int parent = int.Parse(args[2]), width = int.Parse(args[3]), row = int.Parse(args[4]), interval = int.Parse(args[5]);
        bool fixedPos = args.Length >= 8;
        int fx = fixedPos ? int.Parse(args[6]) : 0, fy = fixedPos ? int.Parse(args[7]) : 0;
        // "screen" as the 7th argument: look at the screen even if window capture is available.
        bool windowCapture = !fixedPos && !(args.Length == 7 && args[6] == "screen");
        const int Height = 8;
        const string Hex = "0123456789abcdef";
        TextWriter o = Console.Out;
#if WGC
        WindowCapture capture = null;
#else
        windowCapture = false;
#endif

        using (Bitmap bmp = new Bitmap(width, Height, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            byte[] px = new byte[width * 4];
            char[] line = new char[2 + width * 6];
            line[0] = 'P'; line[1] = ' ';
            string last = null;
            DateTime lastEmit = DateTime.MinValue;
            IntPtr hwnd = IntPtr.Zero;
            int tick = 0;
            bool stalled = false;
            while (true)
            {
                // Stop when the map server that started us is gone.
                if (++tick % 20 == 0) { try { Process.GetProcessById(parent).Dispose(); } catch { return 0; } }
                int ox, oy;
                bool fresh = true;
                if (fixedPos) { ox = fx; oy = fy; }
                else
                {
                    if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                    {
                        hwnd = Find(names, hint);
                        if (hwnd == IntPtr.Zero) { Status(o, "S nowindow"); last = null; Thread.Sleep(1000); continue; }
                    }
                    if (IsIconic(hwnd)) { Status(o, "S minimized"); last = null; Thread.Sleep(500); continue; }
                    POINT p = new POINT();
                    RECT r;
                    if (!ClientToScreen(hwnd, ref p) || !GetClientRect(hwnd, out r)) { hwnd = IntPtr.Zero; Thread.Sleep(200); continue; }
                    ox = p.X; oy = p.Y;
                    Status(o, "S window " + ox + " " + oy + " " + (r.Right - r.Left) + " " + (r.Bottom - r.Top));
                }
#if WGC
                if (windowCapture)
                {
                    try
                    {
                        if (capture != null && capture.Hwnd != hwnd) { capture.Dispose(); capture = null; }
                        if (capture == null) { capture = WindowCapture.Start(hwnd, width, interval); o.WriteLine("S method window"); o.Flush(); }
                        // The picture starts at the window's visible corner; the strip is at the corner of
                        // the area the game draws in, below the title bar when the window has one.
                        RECT bounds = VisibleBounds(hwnd);
                        fresh = capture.Read(px, ox - bounds.Left, oy - bounds.Top + row, width) == 1;
                        // No new picture for a while although the window is not minimized: the game has
                        // stopped drawing. Say so once, and keep waiting for it to start again.
                        if (fresh) stalled = false;
                        else if (!stalled && (DateTime.UtcNow - capture.LastFrame).TotalMilliseconds > 3000)
                        {
                            stalled = true;
                            last = null;
                            o.WriteLine("S stalled");
                            o.Flush();
                        }
                    }
                    catch (Exception e)
                    {
                        // Window capture is not available here: look at the screen from now on.
                        if (capture != null) { capture.Dispose(); capture = null; }
                        windowCapture = false;
                        o.WriteLine("S method screen " + e.GetType().Name + " 0x" + e.HResult.ToString("x8"));
                        o.Flush();
                    }
                }
#endif
                if (!windowCapture)
                {
                    try { g.CopyFromScreen(ox, oy, 0, 0, new Size(width, Height), CopyPixelOperation.SourceCopy); }
                    catch (Exception e) { Status(o, "S capturefailed " + e.GetType().Name); last = null; Thread.Sleep(500); continue; }
                    BitmapData d = bmp.LockBits(new Rectangle(0, row, width, 1), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    Marshal.Copy(d.Scan0, px, 0, width * 4);
                    bmp.UnlockBits(d);
                }
                if (fresh)
                {
                    for (int i = 0, c = 2; i < width; i++)
                    {
                        byte b = px[i * 4], gr = px[i * 4 + 1], rd = px[i * 4 + 2]; // stored as B, G, R, A
                        line[c++] = Hex[rd >> 4]; line[c++] = Hex[rd & 15];
                        line[c++] = Hex[gr >> 4]; line[c++] = Hex[gr & 15];
                        line[c++] = Hex[b >> 4]; line[c++] = Hex[b & 15];
                    }
                    string s = new string(line);
                    DateTime now = DateTime.UtcNow;
                    if (s != last || (now - lastEmit).TotalMilliseconds > 1000)
                    {
                        o.WriteLine(s);
                        o.Flush();
                        last = s;
                        lastEmit = now;
                    }
                }
                else if (last != null && (DateTime.UtcNow - lastEmit).TotalMilliseconds > 1000)
                {
                    // Nothing new was drawn (a still screen): the last row is still what is showing.
                    o.WriteLine(last);
                    o.Flush();
                    lastEmit = DateTime.UtcNow;
                }
                Thread.Sleep(interval);
            }
        }
    }
}
