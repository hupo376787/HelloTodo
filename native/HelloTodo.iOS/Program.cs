using Avalonia.iOS;
using Foundation;
using UIKit;
using HelloTodo;
[Register("AppDelegate")]
public sealed class AppDelegate : AvaloniaAppDelegate<App> { }
internal static class Program
{
    private static int requestedIcon;
    private static NSObject? activationObserver;
    private static void ApplyIcon()
    {
        var application=UIApplication.SharedApplication;
        application.BeginInvokeOnMainThread(()=>
        {
            if(application.ApplicationState!=UIApplicationState.Active)return;
            var name=requestedIcon==0?null:"Theme"+requestedIcon;
            if(application.SupportsAlternateIcons&&application.AlternateIconName!=name)application.SetAlternateIconName(name,error=>{ });
        });
    }
    static void Main(string[] args)
    {
        AppBranding.ChangeLauncherIcon=index=>{requestedIcon=index;ApplyIcon();};
        activationObserver=NSNotificationCenter.DefaultCenter.AddObserver(UIApplication.DidBecomeActiveNotification,_=>ApplyIcon());
        UIApplication.Main(args,null,typeof(AppDelegate));
    }
}
