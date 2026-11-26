using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
#if !NATIVE_LAYOUT_TESTS
using Avalonia.Headless;
#endif
using Avalonia.Layout;
using Avalonia.LogicalTree;
using Avalonia.Media;
using Avalonia.Styling;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using Avalonia.VisualTree;
using HelloTodo;
using System.Reflection;
using System.Text.Json.Nodes;

internal static class Program
{
    private static readonly string DataPath=Path.Combine(Path.GetTempPath(),"HelloTodo-layout-"+Guid.NewGuid().ToString("N"));
    private static Store? store;
    private static MainView? view;
    private static Window? window;

    [STAThread]
    public static void Main(string[] args)
    {
        var builder=AppBuilder.Configure<LayoutApp>();
        if(args.Contains("--preview")){builder.UsePlatformDetect().StartWithClassicDesktopLifetime(args);return;}
#if NATIVE_LAYOUT_TESTS
        builder.UsePlatformDetect().SetupWithoutStarting();
#else
        builder.UseSkia().UseHeadless(new AvaloniaHeadlessPlatformOptions{UseHeadlessDrawing=!args.Contains("--render")}).SetupWithoutStarting();
#endif
        CreateWindow();
        try
        {
            foreach(var theme in new[]{ThemeVariant.Light,ThemeVariant.Dark})
            {
                store!.State.Theme=theme==ThemeVariant.Dark?"dark":"light";
                foreach(var width in new[]{420d,760d,1200d,1600d})
                {
                    window!.Width=width;window.Height=900;
                    Set("selected","");Set("view","inbox");Refresh();
                    var rows=Field<StackPanel>("rows");
                    var completed=rows.Children.OfType<Expander>().Single();
                    Check(Math.Abs(completed.Bounds.Width-rows.Bounds.Width)<1,"Completed group must fill the task list");
                    var openRows=rows.Children.OfType<Border>().ToArray();
                    Check(openRows.All(row=>Math.Abs(row.Bounds.Width-rows.Bounds.Width)<1),"Tasks must fill the task list");
                    var completedList=(StackPanel)completed.Content!;
                    var completedRow=completedList.Children.First();
                    Check(Math.Abs(completedRow.TranslatePoint(default,rows)!.Value.X-openRows[0].Bounds.X)<.1,"Completed rows must align with open rows without a left inset");
                    var completedHeader=completed.GetVisualDescendants().OfType<Avalonia.Controls.Primitives.ToggleButton>().First();
                    var headerBottom=completedHeader.TranslatePoint(default,completed)!.Value.Y+completedHeader.Bounds.Height;
                    Check(Math.Abs(completedList.TranslatePoint(default,completed)!.Value.Y-headerBottom)<.1,"Completed rows must start immediately below the group header");
                    Check(completed.GetVisualDescendants().OfType<ScrollViewer>().All(s=>s.HorizontalScrollBarVisibility!=Avalonia.Controls.Primitives.ScrollBarVisibility.Visible),"Completed tasks must not force horizontal scrolling");
                    Check(Field<StackPanel>("nav").Children.OfType<Button>().All(b=>b.Background is ISolidColorBrush brush&&brush.Color.A==0),"Navigation backgrounds must be transparent, including the selected item");
                    Set("selected","sample");Refresh();
                    var pane=Field<StackPanel>("pane");var right=Field<Border>("right");
                    Check(pane.Bounds.Width<=right.Bounds.Width,"Detail content must fit the pane");
                    Check(pane.Children.OfType<Border>().Count()==6,"Detail fields must use the Web section order");
                    Check(Field<Border>("detailFooter").IsVisible,"Detail footer must remain outside the scrolling content");
                    Check(pane.GetVisualDescendants().OfType<ComboBox>().All(c=>c.HorizontalAlignment==HorizontalAlignment.Stretch),"Detail selectors must fill their section");
                    Check(pane.GetVisualDescendants().OfType<CalendarDatePicker>().All(c=>c.Bounds.Width>60),"Date pickers must remain usable at minimum width");
                    var before=store.State.Pending.Count;
                    Set("selected","");Refresh();Set("selected","sample");Refresh();
                    if(store.State.Pending.Count!=before)foreach(var operation in store.State.Pending.Skip(before))Console.WriteLine("UNEXPECTED EDIT "+operation.Patch.ToJsonString());
                    Check(store.State.Pending.Count==before,"Opening details must not change imported recurrence or reminder data");
                    if(args.Contains("--render")&&width==1200&&theme==ThemeVariant.Light)
                    {
                        var path=Path.GetFullPath("artifacts/layout-check.png");Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                        using var bitmap=new Avalonia.Media.Imaging.RenderTargetBitmap(new PixelSize(1200,900));
                        bitmap.Render(view!);bitmap.Save(path);Console.WriteLine("RENDER "+path);
                    }
                    Console.WriteLine($"PASS {theme} width={width}: list={rows.Bounds.Width:0}, detail={right.Bounds.Width:0}");
                }
            }
            Set("selected","");Set("view","completed");Refresh();
            Check(Field<StackPanel>("rows").Children.OfType<Expander>().Single().Bounds.Width>0,"Completed-only view must have a width");
            Console.WriteLine("PASS completed-only view");
            Set("selected","sample");Refresh();
            var datePickers=Field<StackPanel>("pane").GetVisualDescendants().OfType<CalendarDatePicker>().ToArray();
            var original=DateTimeOffset.Parse(Store.Str(store!.Get("task","sample"),"reminder"));
            datePickers[0].SelectedDate=datePickers[0].SelectedDate!.Value.AddDays(1);
            Dispatcher.UIThread.RunJobs();
            Check(DateTimeOffset.Parse(Store.Str(store.Get("task","sample"),"reminder"))==original.AddDays(1),"Changing reminder date must preserve local time");
            datePickers[0].SelectedDate=null;
            Dispatcher.UIThread.RunJobs();
            Check(Store.Str(store.Get("task","sample"),"reminder")=="","Clearing reminder date must remove the reminder");
            datePickers[1].SelectedDate=new DateTime(2026,12,15);
            Dispatcher.UIThread.RunJobs();
            Check(Store.Str(store.Get("task","sample"),"due")=="2026-12-15","Due date must remain a date without a time zone shift");
            Console.WriteLine("PASS reminder edit/clear and due date");
            foreach(var scale in new[]{.8,1.6,1d})
            {
                store.State.TextScale=scale;Refresh();
                Check(Math.Abs(Field<TextBlock>("heading").FontSize-28*scale)<.01,"Global text scale must apply to explicit heading sizes without compounding");
                var title=Field<StackPanel>("pane").GetLogicalDescendants().OfType<TextBox>().First();
                Check(Math.Abs(title.FontSize-16*scale)<.01,"Detail title must use the global text scale");
                Refresh();Check(Math.Abs(Field<TextBlock>("heading").FontSize-28*scale)<.01,"Repeated refresh must not compound text scale");
                Check(Field<TextBlock>("status").Bounds.Height>=Field<TextBlock>("status").FontSize*1.2,"Status footer must grow with text size");
            }
            Console.WriteLine("PASS global font size 80/160/100%, no compounding");
            store.State.AccentColor="#e08ca1";Refresh();
            var drawing=(DrawingImage)Field<Image>("appLogo").Source!;
            Check(((GeometryDrawing)((DrawingGroup)drawing.Drawing!).Children[0]).Brush is ISolidColorBrush brush&&brush.Color==Color.Parse("#e08ca1"),"App logo must follow the accent");
            view!.ShowFirstRunWelcome();window!.UpdateLayout();
            Check(Field<Border>("welcome").IsVisible,"First run must offer account sign-in and local mode");
            Console.WriteLine("PASS themed app logo and first-run welcome");
            Field<Border>("welcome").IsVisible=false;
            foreach(var detailWidth in new[]{345d,560d})foreach(var scale in new[]{1d,1.6})
            {
                store.State.DetailWidth=detailWidth;store.State.TextScale=scale;window.Width=1600;
                typeof(MainView).GetMethod("ListEditor",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(view,new object?[]{null,"day"});
                Dispatcher.UIThread.RunJobs();window.UpdateLayout();
                var buttons=Field<StackPanel>("pane").GetLogicalDescendants().OfType<Button>().ToArray();
                foreach(var names in new[]{new[]{"选择背景图片","移除背景图片"},new[]{"保存","取消"}})
                {
                    var first=buttons.Single(b=>Equals(b.Tag,names[0]));var second=buttons.Single(b=>Equals(b.Tag,names[1]));
                    Check(ReferenceEquals(first.GetVisualParent(),second.GetVisualParent()),"List settings action pairs must share one row");
                    Check(Math.Abs(first.Bounds.Y-second.Bounds.Y)<.1&&second.Bounds.X>first.Bounds.X,"List settings action pairs must be side by side");
                }
            }
            Console.WriteLine("PASS list settings horizontal buttons at 345/560px and 100/160% text");
            store.State.TextScale=1;window.Width=1200;Refresh();
            typeof(MainView).GetMethod("Settings",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(view,null);
            Dispatcher.UIThread.RunJobs();window.UpdateLayout();
            var settingsPane=Field<StackPanel>("pane");
            var accentPicker=settingsPane.GetLogicalDescendants().OfType<ColorPicker>().Single();
            Check(!accentPicker.IsHexInputVisible&&!accentPicker.IsComponentTextInputVisible&&!accentPicker.IsAlphaEnabled,"Custom color must offer a visual picker without requiring color codes");
            accentPicker.Color=Color.Parse("#ff914d");
            Check(store.State.AccentColor=="#ff914d","Visual theme selection must immediately update the saved accent");
            Check(!settingsPane.GetLogicalDescendants().OfType<TextBox>().Any(t=>t.Watermark=="#RRGGBB"),"Settings must not display a HEX entry field");
            typeof(MainView).GetMethod("ListEditor",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(view,new object?[]{null,"day"});
            Dispatcher.UIThread.RunJobs();window.UpdateLayout();
            var listPane=Field<StackPanel>("pane");
            var backgroundPicker=listPane.GetLogicalDescendants().OfType<ColorPicker>().Single();
            var dropdown=backgroundPicker.GetVisualDescendants().OfType<DropDownButton>().Single();
            Check(dropdown.Flyout!=null,"Custom color must have a popup palette");
            dropdown.Flyout!.ShowAt(dropdown);
            Dispatcher.UIThread.RunJobs();window.UpdateLayout();
            Check(dropdown.Flyout.IsOpen,"The visual palette must open in a popup");
            if(args.Contains("--render")&&dropdown.Flyout is Flyout flyout&&flyout.Content is Control popupContent)
            {
                var popupRoot=TopLevel.GetTopLevel(popupContent)!;popupRoot.UpdateLayout();
                Check(popupRoot.Bounds.Width>100&&popupRoot.Bounds.Height>100,"The popup must display a usable color spectrum");
                using var popupBitmap=new Avalonia.Media.Imaging.RenderTargetBitmap(new PixelSize((int)Math.Ceiling(popupRoot.Bounds.Width),(int)Math.Ceiling(popupRoot.Bounds.Height)));
                popupBitmap.Render(popupRoot);popupBitmap.Save(Path.GetFullPath("artifacts/color-picker-check.png"));
            }
            dropdown.Flyout.Hide();
            var customColor=listPane.GetLogicalDescendants().OfType<CheckBox>().Single();
            customColor.IsChecked=false;
            var palette=(StackPanel)backgroundPicker.GetLogicalParent()!;
            var preset=((WrapPanel)palette.Children[0]).Children.OfType<Button>().First();
            preset.RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Check(customColor.IsChecked==true,"Choosing the current preset must enable custom background color");
            customColor.IsChecked=false;
            backgroundPicker.Color=Color.Parse("#ffe2c7");
            Check(customColor.IsChecked==true,"Picking a background must enable its preview");
            Check(store.Appearance("day")["color"]?.ToString()!="#ffe2c7","List background changes must wait for Save");
            listPane.GetLogicalDescendants().OfType<Button>().Single(b=>Equals(b.Tag,"保存")).RaiseEvent(new Avalonia.Interactivity.RoutedEventArgs(Button.ClickEvent));
            Check(store.Appearance("day")["color"]?.ToString()=="#ffe2c7","Saving must retain the color chosen in the popup");
            Console.WriteLine("PASS visual theme/background color pickers, preset selection and save");

        }
        finally{window!.Close();store!.Dispose();}
    }

    private static void CreateWindow()
    {
        store=new Store(DataPath);
        store.Edit("task","sample",new JsonObject{["title"]="任务详情与网页布局一致",["listId"]="inbox",["createdAt"]="2026-11-26T02:00:00Z",["notes"]="步骤、日期提醒、附件和备注分组显示。",["reminder"]="2026-12-01T09:00:00+08:00",["repeat"]=new JsonObject{["pattern"]=new JsonObject{["type"]="absoluteMonthly",["interval"]=2}}});
        store.Edit("task","long",new JsonObject{["title"]=new string('长',160),["listId"]="inbox"});
        store.Edit("task","done",new JsonObject{["title"]="已完成任务",["listId"]="inbox",["completed"]=true});
        store.Edit("step","step",new JsonObject{["title"]="验证步骤",["taskId"]="sample",["completed"]=false,["position"]=1});
        var pending=store.State.Pending.Count;
        view=new MainView(store);Set("view","inbox");Set("selected","sample");
        window=new Window{Title="HelloTodo Layout Preview",Width=1200,Height=900,Content=view};window.Show();Refresh();
        Check(store.State.Pending.Count==pending,"First detail opening must preserve original data");
    }
    private static T Field<T>(string name)=>(T)typeof(MainView).GetField(name,BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(view)!;
    private static void Set(string name,object value)=>typeof(MainView).GetField(name,BindingFlags.NonPublic|BindingFlags.Instance)!.SetValue(view,value);
    private static void Refresh(){typeof(MainView).GetMethod("Refresh",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(view,null);Dispatcher.UIThread.RunJobs();window!.UpdateLayout();}
    private static void Check(bool condition,string message){if(!condition)throw new InvalidOperationException(message);}
    public sealed class LayoutApp : Application
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
            if(ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop){CreateWindow();desktop.MainWindow=window;}
            base.OnFrameworkInitializationCompleted();
        }
    }
}
