using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;

namespace HelloTodo;

public sealed partial class MainView
{
    private CancellationTokenSource? accountLogin;
    private readonly Border welcome=new(){IsVisible=false,Padding=new Thickness(18)};
    private TextBlock? loginMessage;
    public void ShowFirstRunWelcome()
    {
        if(store.Cloud!=null||store.State.WelcomeSeen)return;
        var panel=new StackPanel{Spacing=12,MaxWidth=420};
        panel.Children.Add(new Image{Source=AppBranding.Drawing(Accent),Width=56,Height=56,HorizontalAlignment=HorizontalAlignment.Left});
        panel.Children.Add(T("欢迎使用 HelloTodo",26));panel.Children.Add(T("注册或登录，在手机、电脑和网页间同步任务。"));
        AddSignInButtons(panel);
        loginMessage=T("",12);panel.Children.Add(loginMessage);
        panel.Children.Add(B("暂不登录，使用本地模式",()=>{accountLogin?.Cancel();store.State.WelcomeSeen=true;store.Save();welcome.IsVisible=false;Refresh();}));
        var card=new Border{Background=SurfaceBrush(),CornerRadius=new CornerRadius(14),Padding=new Thickness(24),Child=panel,MaxWidth=480,HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center};
        welcome.Background=new SolidColorBrush(DefaultMain);welcome.Child=new ScrollViewer{Content=card,HorizontalScrollBarVisibility=Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled};welcome.IsVisible=true;ApplyTextSizes();
    }
    private void AddSignInButtons(StackPanel panel)
    {
        panel.Children.Add(B("邮箱注册或登录",async()=>await SignInAccount(null)));
        foreach(var provider in new[]{("microsoft","Microsoft"),("google","Google"),("apple","Apple")})panel.Children.Add(B("使用 "+provider.Item2+" 登录",async()=>await SignInAccount(provider.Item1)));
    }
    private Control AccountSetting()
    {
        var panel=new StackPanel{Spacing=7};
        panel.Children.Add(T(store.Cloud?.AccountId is { }?"已登录 · 自动同步":"登录后，自动同步其他设备的任务",12));
        AddSignInButtons(panel);
        if(store.Cloud?.AccountId!=null)
        {
            panel.Children.Add(B("将本机本地任务合并到此账号",async()=>{try{store.MergeLocalIntoAccount();Refresh();await Sync();}catch(Exception error){Status(error.Message);}}));
            panel.Children.Add(B("退出账号",async()=>{try{await store.SignOutAccount();Refresh();}catch(Exception error){Status(error.Message);}}));
        }
        panel.Children.Add(B("取消正在进行的登录",()=>accountLogin?.Cancel()));
        return SettingsCard("账号","同一个账号在各端使用同一份云端数据",panel);
    }
    private async Task SignInAccount(string? provider)
    {
        if(accountLogin!=null||store.Busy||microsoftImport!=null){Status("请等待当前登录、导入或同步完成");return;}
        using var cancellation=new CancellationTokenSource();accountLogin=cancellation;
        try
        {
            if(loginMessage!=null)loginMessage.Text="请在浏览器完成登录，并确认连接此设备。";
            var launcher=TopLevel.GetTopLevel(this)?.Launcher??throw new InvalidOperationException("无法打开浏览器");
            var endpoint=AccountLogin.ServerUrl();if(endpoint=="")endpoint=store.Cloud?.Endpoint??"";
            var result=await AccountLogin.SignIn(endpoint,provider,uri=>launcher.LaunchUriAsync(uri),cancellation.Token);
            await store.ConnectAccount(endpoint,result);welcome.IsVisible=false;showSettings=false;selected="";accountLogin=null;Refresh();await Sync();
            Status("已登录并同步，可在设置中选择合并本机本地任务。");
        }
        catch(OperationCanceledException){if(loginMessage!=null)loginMessage.Text="登录已取消或超时，可重新登录。";Status("登录已取消或超时");}
        catch(Exception error){if(loginMessage!=null)loginMessage.Text=error.Message;Status(error.Message);}
        finally{accountLogin=null;}
    }
}
