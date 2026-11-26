using System.Runtime.InteropServices;

internal static class MacDockIcon
{
    [DllImport("/usr/lib/libobjc.A.dylib")] private static extern IntPtr objc_getClass(string name);
    [DllImport("/usr/lib/libobjc.A.dylib")] private static extern IntPtr sel_registerName(string name);
    [DllImport("/usr/lib/libobjc.A.dylib",EntryPoint="objc_msgSend")] private static extern IntPtr Send(IntPtr receiver,IntPtr selector);
    [DllImport("/usr/lib/libobjc.A.dylib",EntryPoint="objc_msgSend")] private static extern IntPtr SendObject(IntPtr receiver,IntPtr selector,IntPtr argument);
    [DllImport("/usr/lib/libobjc.A.dylib",EntryPoint="objc_msgSend")] private static extern IntPtr SendBytes(IntPtr receiver,IntPtr selector,IntPtr bytes,nuint length);
    public static void Update(byte[] png)
    {
        if(!OperatingSystem.IsMacOS())return;
        var buffer=Marshal.AllocHGlobal(png.Length);
        try
        {
            Marshal.Copy(png,0,buffer,png.Length);
            var data=SendBytes(objc_getClass("NSData"),sel_registerName("dataWithBytes:length:"),buffer,(nuint)png.Length);
            var image=SendObject(Send(objc_getClass("NSImage"),sel_registerName("alloc")),sel_registerName("initWithData:"),data);
            if(image==IntPtr.Zero)return;
            var app=Send(objc_getClass("NSApplication"),sel_registerName("sharedApplication"));
            SendObject(app,sel_registerName("setApplicationIconImage:"),image);Send(image,sel_registerName("release"));
        }
        finally{Marshal.FreeHGlobal(buffer);}
    }
}
