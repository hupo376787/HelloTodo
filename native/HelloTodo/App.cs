using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Themes.Fluent;
namespace HelloTodo;
public sealed class App : Application
{
    public override void Initialize()
    {
        Styles.Add(new FluentTheme());
        Styles.Add(new Avalonia.Markup.Xaml.Styling.StyleInclude(new Uri("avares://HelloTodo/"))
        {
            Source=new Uri("avares://Avalonia.Controls.ColorPicker/Themes/Fluent/Fluent.xaml")
        });
    }
    public override void OnFrameworkInitializationCompleted()
    {
        var view = new MainView();
        view.AttachedToVisualTree+=(_,_)=>view.ShowFirstRunWelcome();
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            desktop.MainWindow = new Window { Title="HelloTodo", Width=1200, Height=760, MinWidth=420, MinHeight=450, Content=view };
        else if (ApplicationLifetime is ISingleViewApplicationLifetime single) single.MainView=view;
        base.OnFrameworkInitializationCompleted();
    }
}
