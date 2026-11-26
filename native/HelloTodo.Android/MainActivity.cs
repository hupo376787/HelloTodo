using Android.App;
using Android.Content.PM;
using Android.Content;
using Android.OS;
using Avalonia.Android;
using HelloTodo;
[Activity(Name="com.hellotodo.app.MainActivity",Label="HelloTodo",Exported=true,ConfigurationChanges=ConfigChanges.Orientation|ConfigChanges.ScreenSize|ConfigChanges.UiMode)]
public sealed class MainActivity : AvaloniaMainActivity<App>
{
    protected override void OnCreate(Bundle? state)
    {
        AppBranding.ChangeLauncherIcon=index=>RunOnUiThread(()=>
        {
            var manager=PackageManager;if(manager==null)return;
            var settings=GetSharedPreferences("appearance",FileCreationMode.Private);
            if(settings?.GetInt("launcherIcon",0)==index)return;
            var package=PackageName??"com.hellotodo.app";
            manager.SetComponentEnabledSetting(new ComponentName(package,package+".Icon"+index),ComponentEnabledState.Enabled,ComponentEnableOption.DontKillApp);
            for(int i=0;i<AppBranding.Colors.Length;i++)if(i!=index)manager.SetComponentEnabledSetting(new ComponentName(package,package+".Icon"+i),ComponentEnabledState.Disabled,ComponentEnableOption.DontKillApp);
            settings?.Edit()?.PutInt("launcherIcon",index)?.Apply();
        });
        base.OnCreate(state);
    }
}
