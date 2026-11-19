// Reads one thin row of pixels from the game window and prints it, so the map server can decode
// the strip the AzerothAtlas addon draws there. The strip is in the window's top-left corner
// unless you have moved it (the addon's options: another corner, so many pixels in). Where it
// is not found in the top-left corner, the whole picture of the window is looked through for
// its first seven squares (white, black, white, black, red, green, blue), and it is read where
// they are from then on - and looked for again when it is no longer there.
//
// Two ways of looking, both of them plain picture capture:
//   window  the game window's own picture, through the Windows capture API that streaming and
//           screen-sharing programs use (Windows.Graphics.Capture). It does not matter what is
//           in front of the game or where the window is, only that it is not minimized.
//   screen  that spot of the screen, like a screenshot. Used when window capture is not
//           available, and stops working while another window covers the game's corner.
// Neither opens, reads or modifies the game process, and no input is sent to it.
//
// The same picture has the game's minimap on it, and inside a dungeon that is the one thing that
// shows where you are (server/minimap.js). So, only while it is asked to, the helper also hands
// over one small square of the picture a few times a second: the square the minimap is in. It
// is asked through its input, a line at a time:
//   "M <x> <y> <w> <h> <ms>"   send that square of the area the game draws in (counted from its
//                              top-left corner), no more often than every so many milliseconds
//   "M off"                    send none
// Nothing else is read from the input, and with no such line nothing but the strip is ever sent.
//
// Built automatically by server/tracker.js with the C# compiler that ships with Windows (the
// WGC symbol is defined when the Windows capture API can be compiled in).
// Output lines:  "S <status...>"  when the status changes,  "P <rgb hex>"  when the pixels change,
//                "M <x> <y> <w> <h> <rgb base64>"  a square of the picture (the part of what was
//                asked for that is in the picture), rows from the top, red green blue a pixel.
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

    // The square of the picture that is asked for (see the top of this file): where it is in the
    // area the game draws in, how big, and how many milliseconds are left between two of them.
    // miniOn: one is asked for at all. Set from the thread that reads the input, read in the loop.
    static volatile bool miniOn;
    static volatile int miniX, miniY, miniW, miniH, miniEvery = 200;
    static readonly object miniLock = new object();
    const int MiniMost = 1024; // (a square is never bigger than this each way: it is the minimap that is wanted, not the window)

    static void Ask(string line)
    {
        string[] p = line.Trim().Split(' ');
        if (p.Length < 2 || p[0] != "M") return;
        if (p[1] == "off") { miniOn = false; return; }
        if (p.Length < 6) return;
        int x, y, w, h, every;
        if (!int.TryParse(p[1], out x) || !int.TryParse(p[2], out y) || !int.TryParse(p[3], out w) || !int.TryParse(p[4], out h) || !int.TryParse(p[5], out every)) return;
        if (w < 8 || h < 8 || w > MiniMost || h > MiniMost) { miniOn = false; return; }
        lock (miniLock) { miniX = x; miniY = y; miniW = w; miniH = h; miniEvery = Math.Max(50, every); miniOn = true; }
    }
    // What is asked for is read as it comes, beside the watching of the game (the map server
    // writes a line when what it wants changes; started with nothing to read from, this ends at once).
    static void Listen()
    {
        Thread t = new Thread(delegate ()
        {
            try { string line; while ((line = Console.In.ReadLine()) != null) Ask(line); }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    // A square of a picture as the line it is sent as. px: its pixels (B, G, R, A), rows of pitch bytes.
    static string MiniLine(byte[] px, int pitch, int x, int y, int w, int h)
    {
        byte[] rgb = new byte[w * h * 3];
        for (int j = 0, o = 0; j < h; j++)
        {
            int p = j * pitch;
            for (int i = 0; i < w; i++, p += 4) { rgb[o++] = px[p + 2]; rgb[o++] = px[p + 1]; rgb[o++] = px[p]; }
        }
        return "M " + x + " " + y + " " + w + " " + h + " " + Convert.ToBase64String(rgb);
    }

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

    // ---- finding the strip ---------------------------------------------------------------------
    // What a pixel (stored B, G, R, A) shows as one of the strip's digits: red 4, green 2, blue 1.
    static int Digit(byte[] p, int x)
    {
        int i = x * 4;
        return (p[i + 2] > 128 ? 4 : 0) | (p[i + 1] > 128 ? 2 : 0) | (p[i] > 128 ? 1 : 0);
    }
    static readonly int[] Sync = { 7, 0, 7, 0, 4, 2, 1 };

    // Where the strip begins in a row of `n` pixels: its first seven squares, each as wide as the
    // others (2 to 32 pixels). -1 when they are not in this row. `from`: look no further left.
    static int FindStart(byte[] p, int n, int from)
    {
        int x = Math.Max(1, from);
        while (x < n)
        {
            // a black run that follows white: the strip's second square, perhaps
            if (Digit(p, x) != 0 || Digit(p, x - 1) != 7) { x++; continue; }
            int start = x;
            while (x < n && x - start < 34 && Digit(p, x) == 0) x++;
            int len = x - start;
            if (len < 2 || len > 33) continue;
            for (int k = 0; k < 5; k++)
            {
                // (the square's width, give or take a blended edge)
                double w = len + (k == 0 ? 0 : k == 1 ? -0.5 : k == 2 ? 0.5 : k == 3 ? -1 : 1);
                double s = start - w;
                if (w < 2 || s < -0.6) continue;
                bool ok = true;
                for (int i = 0; i < Sync.Length && ok; i++)
                {
                    int at = (int)Math.Floor(s + (i + 0.5) * w);
                    if (at < 0 || at >= n || Digit(p, at) != Sync[i]) ok = false;
                }
                if (ok) return Math.Max(0, (int)Math.Round(s));
            }
        }
        return -1;
    }
    // Is the strip at the very start of this row?
    static bool StartsHere(byte[] p, int n)
    {
        int at = FindStart(p, Math.Min(n, 300), 0);
        return at >= 0 && at <= 2;
    }
    // Look through a whole picture (rows of `pitch` bytes, B, G, R, A) for the strip: where its
    // top-left corner is. Every other row is looked at (the strip is six pixels high), and what
    // is found has to be in the row under it as well - a strip, and not a chance likeness.
    static bool Search(IntPtr data, int pitch, int w, int h, out int fx, out int fy)
    {
        fx = -1; fy = -1;
        byte[] row = new byte[w * 4], under = new byte[w * 4];
        for (int y = 0; y + 1 < h; y += 2)
        {
            Marshal.Copy(new IntPtr(data.ToInt64() + (long)y * pitch), row, 0, row.Length);
            bool have = false;
            for (int from = 0; ; )
            {
                int at = FindStart(row, w, from);
                if (at < 0) break;
                if (!have) { Marshal.Copy(new IntPtr(data.ToInt64() + (long)(y + 1) * pitch), under, 0, under.Length); have = true; }
                int below = FindStart(under, Math.Min(w, at + 300), Math.Max(0, at - 2));
                if (below >= 0 && Math.Abs(below - at) <= 1) { fx = at; fy = y; return true; }
                from = at + 8;
            }
        }
        return false;
    }
    // The same for the screen: the area the game draws in, at (ox, oy), w by h.
    static bool SearchScreen(int ox, int oy, int w, int h, out int fx, out int fy)
    {
        fx = -1; fy = -1;
        if (w < 40 || h < 8) return false;
        try
        {
            using (Bitmap all = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            using (Graphics gg = Graphics.FromImage(all))
            {
                gg.CopyFromScreen(ox, oy, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                BitmapData d = all.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try { return Search(d.Scan0, d.Stride, w, h, out fx, out fy); }
                finally { all.UnlockBits(d); }
            }
        }
        catch { return false; }
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
        // Asked to look through the next picture for the strip (WantScan); Scanned once that has
        // been done, with where it is in the picture (FoundX, FoundY: -1 when it is not in it).
        public bool WantScan, Scanned;
        public int FoundX = -1, FoundY = -1;
        // Asked for a square of the next picture as well (WantMini: where in the picture, how big);
        // GotMini once it has been taken, with its pixels in Mini (rows of MiniPitch bytes) and
        // what of it was inside the picture (MiniGotW by MiniGotH, from MiniX, MiniY).
        public bool WantMini, GotMini;
        public int MiniX, MiniY, MiniW, MiniH, MiniGotW, MiniGotH, MiniPitch;
        public byte[] Mini;
        IntPtr miniStaging;
        int miniStagingW, miniStagingH;

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
                    if (WantScan)
                    {
                        WantScan = false; Scanned = true; FoundX = -1; FoundY = -1;
                        try { Locate(texture); } catch { }
                    }
                    if (WantMini)
                    {
                        WantMini = false;
                        try { TakeMini(texture); } catch { GotMini = false; }
                    }
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

        // The square that is asked for, out of this picture: copied into a small texture of its own
        // that the CPU can read (kept from one time to the next, made anew when another size is asked for).
        void TakeMini(IntPtr texture)
        {
            int x = Math.Max(0, MiniX), y = Math.Max(0, MiniY);
            int w = Math.Min(MiniX + MiniW, FrameWidth) - x, h = Math.Min(MiniY + MiniH, FrameHeight) - y;
            if (w < 8 || h < 8) return;
            if (miniStaging == IntPtr.Zero || miniStagingW != w || miniStagingH != h)
            {
                if (miniStaging != IntPtr.Zero) { Marshal.Release(miniStaging); miniStaging = IntPtr.Zero; }
                TEXTURE2D_DESC d = new TEXTURE2D_DESC();
                d.Width = (uint)w; d.Height = (uint)h; d.MipLevels = 1; d.ArraySize = 1; d.Format = 87 /* B8G8R8A8_UNORM */;
                d.SampleCount = 1; d.Usage = 3 /* staging */; d.CPUAccessFlags = 0x20000 /* read */;
                if (((CreateTexture2DFn)Method(device, 5, typeof(CreateTexture2DFn)))(device, ref d, IntPtr.Zero, out miniStaging) < 0) { miniStaging = IntPtr.Zero; return; }
                miniStagingW = w; miniStagingH = h;
            }
            BOX box = new BOX();
            box.Left = (uint)x; box.Top = (uint)y; box.Front = 0; box.Right = (uint)(x + w); box.Bottom = (uint)(y + h); box.Back = 1;
            copyRegion(context, miniStaging, 0, 0, 0, 0, texture, 0, ref box);
            MAPPED m;
            if (map(context, miniStaging, 0, 1 /* read */, 0, out m) < 0) return;
            try
            {
                int pitch = (int)m.RowPitch;
                if (Mini == null || Mini.Length < pitch * h) Mini = new byte[pitch * h];
                Marshal.Copy(m.Data, Mini, 0, pitch * (h - 1) + w * 4);
                MiniPitch = pitch; MiniGotW = w; MiniGotH = h;
                // (where it is in the picture, as it was taken: what was asked for may have been cut at the picture's edge)
                MiniX = x; MiniY = y;
                GotMini = true;
            }
            finally { unmap(context, miniStaging, 0); }
        }

        // Look through the whole picture for the strip: a copy of it the CPU can read, made for
        // this one look (it is done only while the strip is not where it was last read).
        void Locate(IntPtr texture)
        {
            TEXTURE2D_DESC d = new TEXTURE2D_DESC();
            d.Width = (uint)FrameWidth; d.Height = (uint)FrameHeight; d.MipLevels = 1; d.ArraySize = 1; d.Format = 87 /* B8G8R8A8_UNORM */;
            d.SampleCount = 1; d.Usage = 3 /* staging */; d.CPUAccessFlags = 0x20000 /* read */;
            IntPtr whole;
            if (((CreateTexture2DFn)Method(device, 5, typeof(CreateTexture2DFn)))(device, ref d, IntPtr.Zero, out whole) < 0) return;
            try
            {
                BOX box = new BOX();
                box.Left = 0; box.Top = 0; box.Front = 0; box.Right = (uint)FrameWidth; box.Bottom = (uint)FrameHeight; box.Back = 1;
                copyRegion(context, whole, 0, 0, 0, 0, texture, 0, ref box);
                MAPPED m;
                if (map(context, whole, 0, 1 /* read */, 0, out m) < 0) return;
                try { Search(m.Data, (int)m.RowPitch, FrameWidth, FrameHeight, out FoundX, out FoundY); }
                finally { unmap(context, whole, 0); }
            }
            finally { Marshal.Release(whole); }
        }

        public void Dispose()
        {
            try { if (session != null) session.Dispose(); } catch { }
            try { if (pool != null) pool.Dispose(); } catch { }
            session = null; pool = null; item = null; winrtDevice = null;
            if (staging != IntPtr.Zero) { Marshal.Release(staging); staging = IntPtr.Zero; }
            if (miniStaging != IntPtr.Zero) { Marshal.Release(miniStaging); miniStaging = IntPtr.Zero; }
            if (context != IntPtr.Zero) { Marshal.Release(context); context = IntPtr.Zero; }
            if (device != IntPtr.Zero) { Marshal.Release(device); device = IntPtr.Zero; }
        }
    }
#endif

    static int Main(string[] args)
    {
        // (for the tests) "find <picture file>": look through a picture for the strip, as the
        // whole of the game window is looked through, and say where it is.
        if (args.Length == 2 && args[0] == "find")
        {
            using (Bitmap picture = new Bitmap(args[1]))
            {
                BitmapData d = picture.LockBits(new Rectangle(0, 0, picture.Width, picture.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                int x, y;
                bool found = Search(d.Scan0, d.Stride, picture.Width, picture.Height, out x, out y);
                picture.UnlockBits(d);
                Console.Out.WriteLine(found ? "F " + x + " " + y : "F none");
            }
            return 0;
        }
        // (for the tests) "crop <picture file> <x> <y> <w> <h>": a square of a picture, as the line
        // a square of the game's picture is sent as.
        if (args.Length == 6 && args[0] == "crop")
        {
            using (Bitmap picture = new Bitmap(args[1]))
            {
                int x = Math.Max(0, int.Parse(args[2])), y = Math.Max(0, int.Parse(args[3]));
                int w = Math.Min(x + int.Parse(args[4]), picture.Width) - x, h = Math.Min(y + int.Parse(args[5]), picture.Height) - y;
                if (w < 1 || h < 1) { Console.Out.WriteLine("M none"); return 0; }
                BitmapData d = picture.LockBits(new Rectangle(x, y, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                byte[] all = new byte[d.Stride * h];
                Marshal.Copy(d.Scan0, all, 0, d.Stride * (h - 1) + w * 4);
                picture.UnlockBits(d);
                Console.Out.WriteLine(MiniLine(all, d.Stride, x, y, w, h));
            }
            return 0;
        }
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
        Listen();
        DateTime lastMini = DateTime.MinValue;
        Bitmap miniBmp = null;
        byte[] miniPx = null;
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
            // Where the strip begins, counted from the corner of the area the game draws in (0, 0:
            // that corner itself, where it is unless you have moved it). misses: looks in a row
            // that did not find it there. After a dozen of those in a row the whole picture is
            // looked through for it (nextScan: when that may next be done; scanGap: how long is
            // left between two such looks - longer each time nothing is found, as when the game
            // is showing no strip at all).
            int offX = 0, offY = 0, misses = 0, clientW = 0, clientH = 0;
            // (for the tests: begin as if it had last been read somewhere else, so that it has to be found)
            try
            {
                string begin = Environment.GetEnvironmentVariable("ATLAS_STRIP_START");
                if (!string.IsNullOrEmpty(begin)) { string[] at = begin.Split(','); offX = int.Parse(at[0]); offY = int.Parse(at[1]); }
            }
            catch { offX = 0; offY = 0; }
            DateTime nextScan = DateTime.UtcNow;
            double scanGap = 1500;
            string place = "S strip 0 0";
            while (true)
            {
                // Stop when the map server that started us is gone.
                if (++tick % 20 == 0) { try { Process.GetProcessById(parent).Dispose(); } catch { return 0; } }
                int ox, oy;
                bool fresh = true;
                bool look = !fixedPos && misses >= 12 && DateTime.UtcNow >= nextScan;
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
                    clientW = r.Right - r.Left; clientH = r.Bottom - r.Top;
                    Status(o, "S window " + ox + " " + oy + " " + clientW + " " + clientH);
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
                        int cornerX = ox - bounds.Left, cornerY = oy - bounds.Top;
                        if (look) capture.WantScan = true;
                        // (the minimap's square, when it is asked for and it is time for one: out of the same picture)
                        if (miniOn && (DateTime.UtcNow - lastMini).TotalMilliseconds >= miniEvery)
                        {
                            int askX, askY, askW, askH;
                            lock (miniLock) { askX = miniX; askY = miniY; askW = miniW; askH = miniH; }
                            // (no further than the area the game draws in)
                            if (askX < 0) { askW += askX; askX = 0; }
                            if (askY < 0) { askH += askY; askY = 0; }
                            askW = Math.Min(askW, clientW - askX); askH = Math.Min(askH, clientH - askY);
                            capture.MiniX = cornerX + askX; capture.MiniY = cornerY + askY; capture.MiniW = askW; capture.MiniH = askH;
                            capture.GotMini = false;
                            capture.WantMini = askW >= 8 && askH >= 8;
                        }
                        fresh = capture.Read(px, cornerX + offX, cornerY + offY + row, width) == 1;
                        capture.WantMini = false;
                        if (capture.Scanned)
                        {
                            // The whole picture has been looked through: the strip is read where it was
                            // found from now on (the row just read was still the old place's).
                            capture.Scanned = false;
                            if (capture.FoundX >= 0)
                            {
                                offX = capture.FoundX - cornerX; offY = capture.FoundY - cornerY;
                                misses = 0; scanGap = 1500; fresh = false; last = null;
                            }
                            else scanGap = Math.Min(scanGap * 2, 12000);
                            nextScan = DateTime.UtcNow.AddMilliseconds(scanGap);
                        }
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
                    if (look)
                    {
                        // (the same look through the whole of the game's area, on the screen)
                        int sx, sy;
                        if (SearchScreen(ox, oy, clientW, clientH, out sx, out sy)) { offX = sx; offY = sy; misses = 0; scanGap = 1500; last = null; }
                        else scanGap = Math.Min(scanGap * 2, 12000);
                        nextScan = DateTime.UtcNow.AddMilliseconds(scanGap);
                    }
                    try { g.CopyFromScreen(ox + offX, oy + offY, 0, 0, new Size(width, Height), CopyPixelOperation.SourceCopy); }
                    catch (Exception e) { Status(o, "S capturefailed " + e.GetType().Name); last = null; Thread.Sleep(500); continue; }
                    BitmapData d = bmp.LockBits(new Rectangle(0, row, width, 1), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                    Marshal.Copy(d.Scan0, px, 0, width * 4);
                    bmp.UnlockBits(d);
                }
                if (!fixedPos)
                {
                    // Is the strip where it is being read? (For the map's page: where it is, said when that changes.)
                    if (fresh) { if (StartsHere(px, width)) misses = 0; else if (misses < 100000) misses++; }
                    string spot = "S strip " + offX + " " + offY;
                    if (spot != place) { place = spot; o.WriteLine(place); o.Flush(); }
                }
                if (!windowCapture && miniOn && (DateTime.UtcNow - lastMini).TotalMilliseconds >= miniEvery)
                {
                    // (looking at the screen: the minimap's square is that spot of the screen)
                    int ax, ay, aw, ah;
                    lock (miniLock) { ax = miniX; ay = miniY; aw = miniW; ah = miniH; }
                    if (ax < 0) { aw += ax; ax = 0; }
                    if (ay < 0) { ah += ay; ay = 0; }
                    if (!fixedPos) { aw = Math.Min(aw, clientW - ax); ah = Math.Min(ah, clientH - ay); }
                    lastMini = DateTime.UtcNow;
                    if (aw >= 8 && ah >= 8)
                    {
                        try
                        {
                            if (miniBmp == null || miniBmp.Width != aw || miniBmp.Height != ah) { if (miniBmp != null) miniBmp.Dispose(); miniBmp = new Bitmap(aw, ah, PixelFormat.Format32bppArgb); }
                            using (Graphics mg = Graphics.FromImage(miniBmp)) mg.CopyFromScreen(ox + ax, oy + ay, 0, 0, new Size(aw, ah), CopyPixelOperation.SourceCopy);
                            BitmapData md = miniBmp.LockBits(new Rectangle(0, 0, aw, ah), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                            if (miniPx == null || miniPx.Length < md.Stride * ah) miniPx = new byte[md.Stride * ah];
                            Marshal.Copy(md.Scan0, miniPx, 0, md.Stride * (ah - 1) + aw * 4);
                            int stride = md.Stride;
                            miniBmp.UnlockBits(md);
                            o.WriteLine(MiniLine(miniPx, stride, ax, ay, aw, ah));
                            o.Flush();
                        }
                        catch { }
                    }
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
#if WGC
                if (windowCapture && capture != null && capture.GotMini)
                {
                    // (the square that was taken out of the picture the strip's row came from: sent after that row)
                    capture.GotMini = false;
                    lastMini = DateTime.UtcNow;
                    RECT edge = VisibleBounds(hwnd);
                    o.WriteLine(MiniLine(capture.Mini, capture.MiniPitch, capture.MiniX - (ox - edge.Left), capture.MiniY - (oy - edge.Top), capture.MiniGotW, capture.MiniGotH));
                    o.Flush();
                }
#endif
                Thread.Sleep(interval);
            }
        }
    }
}
