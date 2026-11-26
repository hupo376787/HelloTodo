using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using Avalonia.Styling;
using System.Text.Json.Nodes;

namespace HelloTodo;

public sealed partial class MainView
{
    private readonly Grid toolbar=new(){ColumnDefinitions=new("Auto,Auto,*,Auto,Auto")};
    private readonly Border centerHost=new();
    private readonly Grid centerLayers=new();
    private readonly Image listBackground=new(){Stretch=Stretch.UniformToFill,IsHitTestVisible=false};
    private readonly Border leftDivider=new(),rightDivider=new();
    private Bitmap? backgroundBitmap;
    private string backgroundKey="";
    private int appearanceEpoch;
    private bool? previousSmall;
    private static readonly (string Name,string Accent,string Background)[] Monet={
        ("默认蓝","#3b82f6","#e8effa"),("雾霾蓝","#79b4df","#dce7ef"),("湖水绿","#61b9aa","#deece7"),
        ("鼠尾草","#8cbb7a","#e3ebdf"),("橄榄绿","#b0bc66","#e9ead8"),("奶油黄","#e6bd67","#f4ecd6"),
        ("杏仁橙","#e9a17c","#f3e4da"),("干枯玫瑰","#e08ca1","#f2e1e5"),("烟粉","#d798c5","#eee3eb"),
        ("薰衣草","#b39be1","#e9e5f2"),("鸢尾紫","#9a90d1","#e3e1ed"),("暖灰棕","#c5a68d","#ede6e0"),("雾灰","#9eafbd","#e5e9ec")};
    private static readonly (string Id,string Label)[] SortOptions={ ("position","创建顺序"),("title","按名称"),("due","按截止日期"),("important","按重要性"),("createdAt","按创建时间") };
    private static string? ValidColor(string? s)=>s!=null&&System.Text.RegularExpressions.Regex.IsMatch(s,"^#[0-9a-fA-F]{6}$")?s.ToLowerInvariant():null;
    private bool Dark=>ActualThemeVariant==ThemeVariant.Dark;
    private IBrush SurfaceBrush()=>Brush.Parse(Dark?"#292929":"#ffffff");
    private static Color Mix(Color a,Color b,double t)=>Color.FromRgb((byte)Math.Round(a.R+(b.R-a.R)*t),(byte)Math.Round(a.G+(b.G-a.G)*t),(byte)Math.Round(a.B+(b.B-a.B)*t));
    private static double Luminance(Color c){double F(byte n){double x=n/255d;return x<=.04045?x/12.92:Math.Pow((x+.055)/1.055,2.4);}return .2126*F(c.R)+.7152*F(c.G)+.0722*F(c.B);}
    private static IBrush Readable(Color c)=>Luminance(c)>=.179?Brushes.Black:Brushes.White;
    private Color Accent=>Color.Parse(ValidColor(store.State.AccentColor)??"#3b82f6");
    private Color DefaultMain=>ValidColor(store.State.AccentColor)=="#3b82f6"?Color.Parse(Dark?"#17243a":"#e8effa"):Mix(Accent,Color.Parse(Dark?"#121212":"#ffffff"),Dark ? .84 : .86);
    private void ApplyTheme(){
        UpdateAppIcon();
        if(Application.Current is { } app)app.RequestedThemeVariant=store.State.Theme switch{"dark"=>ThemeVariant.Dark,"light"=>ThemeVariant.Light,_=>ThemeVariant.Default};
        var top=Dark?Mix(Accent,Color.Parse("#171717"),.65):Accent;
        toolbar.Background=new SolidColorBrush(top);foreach(var item in toolbar.Children){if(item is Button b)b.Foreground=Readable(top);if(item is TextBlock t)t.Foreground=Readable(top);}
        foreach(var brand in toolbar.Children.OfType<StackPanel>())foreach(var text in brand.Children.OfType<TextBlock>())text.Foreground=Readable(top);
        left.Background=right.Background=Brush.Parse(Dark?"#202020":"#f4f4f4");
        leftDivider.Background=rightDivider.Background=Brush.Parse(Dark?"#454545":"#dedede");
        status.Foreground=Brush.Parse(Dark?"#e5e5e5":"#444444");
        foreach(var card in pane.Children.OfType<Border>())card.Background=SurfaceBrush();
        if(detailFooter.Child is Grid footer)foreach(var button in footer.Children.OfType<Button>())if(button.Tag is string title&&title=="删除任务")button.Foreground=Brush.Parse(Dark?"#ff9a92":"#c42b1c");
    }
    private Control MakeSplitter(bool sidebar){
        var divider=sidebar?leftDivider:rightDivider;divider.Cursor=new Cursor(StandardCursorType.SizeWestEast);
        bool dragging=false;double start=0,initial=0;
        divider.PointerPressed+=(_,e)=>{if(!e.GetCurrentPoint(divider).Properties.IsLeftButtonPressed)return;dragging=true;start=e.GetPosition(layout).X;initial=layout.ColumnDefinitions[sidebar?0:4].Width.Value;e.Pointer.Capture(divider);e.Handled=true;};
        divider.PointerMoved+=(_,e)=>{if(!dragging||Bounds.Width<760)return;var opposite=layout.ColumnDefinitions[sidebar?4:0].Width.Value;double width=initial+(e.GetPosition(layout).X-start)*(sidebar?1:-1);double min=sidebar?160:260,max=Math.Max(min,Math.Min(sidebar?520:760,Bounds.Width-280-12-opposite));width=Math.Clamp(width,min,max);if(sidebar)store.State.SidebarWidth=width;else store.State.DetailWidth=width;Resize();e.Handled=true;};
        divider.PointerReleased+=(_,e)=>{if(!dragging)return;dragging=false;e.Pointer.Capture(null);store.Save();e.Handled=true;};
        divider.PointerCaptureLost+=(_,_)=>{if(dragging){dragging=false;store.Save();}};
        divider.DoubleTapped+=(_,_)=>{if(sidebar)store.State.SidebarWidth=260;else store.State.DetailWidth=345;store.Save();Resize();};
        return divider;
    }
    private void Resize(){
        double width=Bounds.Width>0?Bounds.Width:1200;bool small=width<760,hasDetail=showSettings||selected!="";
        if(previousSmall!=small){if(small)navShown=false;else navShown=true;previousSmall=small;}
        bool showLeft=navShown&&(!small||!hasDetail),showRight=hasDetail;
        double l=0,r=0;
        if(small){if(showRight)r=width;else if(showLeft)l=width;}
        else{
            l=showLeft?Math.Clamp(double.IsFinite(store.State.SidebarWidth)?store.State.SidebarWidth:260,160,520):0;
            r=showRight?Math.Clamp(double.IsFinite(store.State.DetailWidth)?store.State.DetailWidth:345,260,760):0;
            var available=Math.Max(0,width-280-(showLeft?6:0)-(showRight?6:0));var min=(showLeft?160:0)+(showRight?260:0);
            if(l+r>available&&l+r>min){var ratio=Math.Clamp((available-min)/(l+r-min),0,1);l=showLeft?160+(l-160)*ratio:0;r=showRight?260+(r-260)*ratio:0;}
        }
        layout.ColumnDefinitions[0].Width=new GridLength(l);layout.ColumnDefinitions[1].Width=new GridLength(!small&&showLeft?6:0);
        layout.ColumnDefinitions[2].Width=small&&(showLeft||showRight)?new GridLength(0):new GridLength(1,GridUnitType.Star);
        layout.ColumnDefinitions[3].Width=new GridLength(!small&&showRight?6:0);layout.ColumnDefinitions[4].Width=new GridLength(r);
        left.IsVisible=showLeft;right.IsVisible=showRight;centerHost.IsVisible=!small||(!showLeft&&!showRight);leftDivider.IsVisible=!small&&showLeft;rightDivider.IsVisible=!small&&showRight;
    }
    private async void ApplyListAppearance(){
        var a=query.Length==0?store.Appearance(view):new JsonObject();var color=ValidColor(a["color"]?.ToString()) is string hex?Color.Parse(hex):DefaultMain;centerHost.Background=new SolidColorBrush(color);heading.Foreground=Readable(color);
        var opacity=double.TryParse(a["backgroundOpacity"]?.ToString(),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var n)?Math.Clamp(n,0,100):65;
        listBackground.Opacity=opacity/100;string id=a["backgroundId"]?.ToString()??"",next=id.Length==0?"":store.Workspace+":"+id;
        if(next==backgroundKey)return;var epoch=++appearanceEpoch;backgroundKey=next;listBackground.Source=null;backgroundBitmap?.Dispose();backgroundBitmap=null;
        if(id.Length==0)return;
        try{var bytes=await store.Download(id);if(epoch!=appearanceEpoch)return;using var ms=new MemoryStream(bytes);backgroundBitmap=new Bitmap(ms);listBackground.Source=backgroundBitmap;}
        catch{if(epoch==appearanceEpoch)backgroundKey="";}
    }
    private Border SettingsCard(string title,string description,params Control[] controls){var panel=new StackPanel{Spacing=8};panel.Children.Add(new TextBlock{Text=title,FontSize=16,FontWeight=FontWeight.SemiBold});panel.Children.Add(new TextBlock{Text=description,FontSize=12,Opacity=.72,TextWrapping=TextWrapping.Wrap});foreach(var control in controls)panel.Children.Add(control);return new Border{Background=SurfaceBrush(),CornerRadius=new CornerRadius(8),Padding=new Thickness(13),Child=panel};}
    private static Control Labelled(string label,Control control){var p=new StackPanel{Spacing=4};p.Children.Add(T(label,12));p.Children.Add(control);return p;}
    private static Grid ButtonRow(params Control[] buttons)
    {
        var row=new Grid{ColumnDefinitions=new(string.Join(",",buttons.Select(_=>"*")))};
        for(int i=0;i<buttons.Length;i++)
        {
            buttons[i].HorizontalAlignment=HorizontalAlignment.Stretch;
            buttons[i].VerticalAlignment=VerticalAlignment.Stretch;
            if(i>0)buttons[i].Margin=new Thickness(8,0,0,0);
            if(buttons[i] is Button button)button.HorizontalContentAlignment=HorizontalAlignment.Center;
            Put(row,buttons[i],i);
        }
        return row;
    }
    private Control Palette(bool accent,TextBox hex,Action<string> select)
    {
        var panel=new StackPanel{Spacing=6};
        var colors=new WrapPanel{Orientation=Orientation.Horizontal};
        var picker=new ColorPicker
        {
            Color=Color.Parse(hex.Text!),Content=T("自定义颜色…"),
            HorizontalAlignment=HorizontalAlignment.Stretch,
            IsAlphaEnabled=false,IsAlphaVisible=false,
            IsColorComponentsVisible=false,IsColorPaletteVisible=false,
            IsColorModelVisible=false,IsComponentTextInputVisible=false,IsHexInputVisible=false
        };
        Avalonia.Automation.AutomationProperties.SetName(picker,accent?"自定义主题色":"自定义背景色");
        bool updating=false;
        void Choose(string value)
        {
            updating=true;
            try{hex.Text=value;picker.Color=Color.Parse(value);}
            finally{updating=false;}
            select(value);
        }
        picker.ColorChanged+=(_,e)=>
        {
            if(updating)return;
            var value=$"#{e.NewColor.R:x2}{e.NewColor.G:x2}{e.NewColor.B:x2}";
            if(value!=hex.Text)Choose(value);
        };
        foreach(var c in Monet)
        {
            var value=accent?c.Accent:c.Background;
            var button=new Button{Content="",Width=34,Height=34,Margin=new Thickness(0,0,6,6),Background=Brush.Parse(value),BorderBrush=Brushes.Gray,BorderThickness=new Thickness(1)};
            ToolTip.SetTip(button,c.Name+" "+value);
            button.Click+=(_,_)=>Choose(value);
            colors.Children.Add(button);
        }
        panel.Children.Add(colors);
        panel.Children.Add(picker);
        return panel;
    }
    private void Settings(){
        pane.Children.Clear();pane.Children.Add(T("App 设置",23));pane.Children.Add(B("‹ 返回任务",()=>{showSettings=false;Refresh();}));
        var theme=new ComboBox{ItemsSource=new[]{"跟随系统","浅色","深色"},SelectedIndex=store.State.Theme switch{"light"=>1,"dark"=>2,_=>0}};
        theme.SelectionChanged+=(_,_)=>{store.State.Theme=theme.SelectedIndex switch{1=>"light",2=>"dark",_=>"system"};store.Save();Refresh();};
        var hex=Box(ValidColor(store.State.AccentColor)??"#3b82f6","#RRGGBB");var palette=Palette(true,hex,value=>{if(store.State.AccentColor==value)return;store.State.AccentColor=value;store.Save();ApplyTheme();RefreshNav();RefreshRows();ApplyListAppearance();});
        pane.Children.Add(SettingsCard("外观","主题模式与莫奈色系 · 当前设备",Labelled("主题",theme),palette,TextSizeSetting()));
        pane.Children.Add(AccountSetting());
        var endpoint=Box(store.Cloud?.Endpoint,"https://你的工作区.workers.dev");var key=Box(null,"工作区密钥");key.PasswordChar='●';
        var connect=B("连接工作区",async()=>{try{if(microsoftImport!=null||accountLogin!=null)throw new InvalidOperationException("请等待微软导入完成");await store.Connect(endpoint.Text??"",key.Text??"");Refresh();await Sync();}catch(Exception e){Status(e.Message);}});
        var disconnect=B("退出云工作区",()=>{try{if(microsoftImport!=null||accountLogin!=null)throw new InvalidOperationException("请等待微软导入完成");store.Disconnect();Refresh();}catch(Exception e){Status(e.Message);}});disconnect.IsEnabled=store.Cloud!=null;
        pane.Children.Add(SettingsCard("Cloudflare 同步",store.Cloud==null?"本地模式 · 可离线使用":"已连接云工作区",Labelled("服务器地址",endpoint),Labelled("工作区密钥",key),connect,disconnect));
        var pending=store.Tasks("attachments-pending").Count();
        var import=B("Microsoft 登录并授权导入",async()=>{if(MicrosoftImport.AcquireToken!=null)await ImportMicrosoft();else await OpenMigration(false);});
        var retry=B("仅重试待补齐附件",async()=>{if(OutlookRecovery.AcquireToken!=null&&store.Cloud!=null)await RecoverNativeOutlook();else await OpenMigration(true);});retry.IsEnabled=pending>0;
        pane.Children.Add(SettingsCard("迁移 Microsoft To Do",$"待补齐任务：{pending}。桌面可使用 Exchange 授权批量补齐；移动端使用网页版迁移，返回 App 后同步。浏览器首次需连接同一工作区。",import,retry));
        pane.Children.Add(SettingsCard("数据备份","导出任务和原始附件，或合并备份",B("导出 JSON（含附件）",async()=>await Export(false)),B("导出 CSV",async()=>await Export(true)),B("恢复 JSON 备份（跳过已有）",async()=>await RestoreBackup())));
    }
    private async Task RecoverNativeOutlook(){
        if(microsoftImport!=null||store.Busy||accountLogin!=null){Status("请等待当前导入或同步结束");return;}
        using var cts=new CancellationTokenSource();microsoftImport=cts;
        try{var acquire=OutlookRecovery.AcquireToken??throw new InvalidOperationException("平台尚未配置 Exchange 登录");Status("请授权 Exchange Online Tasks.Read");var token=await acquire(MicrosoftImport.ClientId(),cts.Token);var result=await OutlookRecovery.Run(store,token,message=>Status(message),cts.Token);Refresh();Status($"补齐 {result.Completed}/{result.Tasks} · 下载 {result.Downloaded} · 跳过 {result.Skipped} · 待补齐 {result.Pending}");if(showSettings&&result.Errors.Count>0)pane.Children.Add(SettingsCard("批量补齐诊断","未匹配或失败任务，可通过网页版继续恢复",result.Errors.Take(20).Select(x=>(Control)T(x,12)).ToArray()));}
        catch(Exception e){Status("Outlook 补齐失败："+e.Message);}finally{microsoftImport=null;}await Sync();
    }
    private async Task OpenMigration(bool retry){
        try{var endpoint=store.Cloud?.Endpoint??throw new InvalidOperationException("请先连接云工作区，再通过网页版迁移附件。");var uri=new Uri(endpoint.TrimEnd('/')+"/index.html#"+(retry?"migration-attachments":"migration"));if(uri.Scheme!="https"&&!(uri.Scheme=="http"&&uri.IsLoopback))throw new InvalidOperationException("迁移地址必须使用 HTTPS");var launcher=TopLevel.GetTopLevel(this)?.Launcher;if(launcher==null||!await launcher.LaunchUriAsync(uri))throw new InvalidOperationException("无法打开浏览器");Status("请在浏览器连接同一工作区，完成迁移后回到 App 同步。");}catch(Exception e){Status(e.Message);}
    }
    private void ListEditor(Record? list,string? smartId=null){
        selected="edit";showSettings=false;detailFooter.Child=null;detailFooter.IsVisible=false;pane.Children.Clear();bool builtin=list==null&&smartId!=null;string id=list?.Id??smartId??Store.NewId();var a=store.Appearance(id);pane.Children.Add(T(list==null&&!builtin?"新建清单":"清单设置",23));
        var name=Box(Store.Str(list,"title"),"清单名称");var groups=new List<Record>{new("group","",new(){["title"]="无分组"})};groups.AddRange(store.All("group"));var group=new ComboBox{ItemsSource=groups.Select(x=>Store.Str(x,"title")).ToArray(),SelectedIndex=Math.Max(0,groups.FindIndex(x=>x.Id==Store.Str(list,"groupId")))};
        var sort=new ComboBox{ItemsSource=SortOptions.Select(x=>x.Label).ToArray(),SelectedIndex=Math.Max(0,Array.FindIndex(SortOptions,x=>x.Id==a["sort"]?.ToString()))};var basic=new List<Control>();if(!builtin){basic.Add(Labelled("名称",name));basic.Add(Labelled("分组",group));}basic.Add(Labelled("排序",sort));pane.Children.Add(SettingsCard("基本设置","名称、分组与任务排序",basic.ToArray()));
        var useColor=new CheckBox{Content="使用自定义背景色",IsChecked=ValidColor(a["color"]?.ToString())!=null};var hex=Box(ValidColor(a["color"]?.ToString())??"#e8effa","#RRGGBB");
        var previewImage=new Image{Stretch=Stretch.UniformToFill,IsHitTestVisible=false};var previewGrid=new Grid();previewGrid.Children.Add(previewImage);previewGrid.Children.Add(new Border{HorizontalAlignment=HorizontalAlignment.Center,VerticalAlignment=VerticalAlignment.Center,Padding=new Thickness(16,9),CornerRadius=new CornerRadius(5),Background=SurfaceBrush(),Child=T("示例任务")});var preview=new Border{Height=140,ClipToBounds=true,CornerRadius=new CornerRadius(6),Child=previewGrid};
        var opacity=new Slider{Minimum=0,Maximum=100,Value=double.TryParse(a["backgroundOpacity"]?.ToString(),out var op)?Math.Clamp(op,0,100):65};var opacityText=T("",12);void UpdatePreview(){preview.Background=useColor.IsChecked==true&&ValidColor(hex.Text) is string value?Brush.Parse(value):new SolidColorBrush(DefaultMain);previewImage.Opacity=opacity.Value/100;opacityText.Text=$"图片不透明度：{opacity.Value:0}%";}
        useColor.IsCheckedChanged+=(_,_)=>UpdatePreview();opacity.PropertyChanged+=(_,e)=>{if(e.Property==Slider.ValueProperty)UpdatePreview();};var palette=Palette(false,hex,value=>{useColor.IsChecked=true;UpdatePreview();});pane.Children.Add(SettingsCard("背景色","莫奈色系，也可打开调色盘选择自定义颜色",useColor,palette));
        string? bgId=a["backgroundId"]?.ToString(),filename=null;byte[]? fileBytes=null;Bitmap? previewBitmap=null;int imageRevision=0;
        void SetImage(byte[]? bytes){Bitmap? bitmap=null;if(bytes!=null){using var ms=new MemoryStream(bytes);bitmap=new Bitmap(ms);}previewImage.Source=null;previewBitmap?.Dispose();previewBitmap=bitmap;previewImage.Source=bitmap;}
        preview.DetachedFromVisualTree+=(_,_)=>{imageRevision++;previewImage.Source=null;previewBitmap?.Dispose();previewBitmap=null;};
        var imageName=T(bgId==null?"未选择图片":"已设置背景图片",12);
        var pick=B("选择背景图片",async()=>{try{var provider=TopLevel.GetTopLevel(this)?.StorageProvider;if(provider==null)return;var rev=imageRevision;var items=await provider.OpenFilePickerAsync(new(){AllowMultiple=false,FileTypeFilter=new[]{new FilePickerFileType("图片"){Patterns=new[]{"*.png","*.jpg","*.jpeg","*.webp","*.gif"}}}});if(items.Count==0)return;var f=items[0];await using var stream=await f.OpenReadAsync();using var ms=new MemoryStream();var buffer=new byte[81920];int read;while((read=await stream.ReadAsync(buffer))>0){if(ms.Length+read>10*1024*1024)throw new IOException("图片最大 10 MiB");ms.Write(buffer,0,read);}var bytes=ms.ToArray();if(rev!=imageRevision)return;SetImage(bytes);imageRevision++;fileBytes=bytes;filename=f.Name;imageName.Text=filename;}catch(Exception e){Status(e.Message);}});
        var clear=B("移除背景图片",()=>{imageRevision++;bgId=null;fileBytes=null;filename=null;imageName.Text="未选择图片";SetImage(null);});pane.Children.Add(SettingsCard("背景图片","保留原图字节 · 可调节透明度",imageName,ButtonRow(pick,clear),opacityText,opacity,preview));UpdatePreview();
        if(bgId!=null){var rev=imageRevision;_ = LoadPreview(bgId,rev);}async Task LoadPreview(string imageId,int rev){try{var bytes=await store.Download(imageId);if(rev==imageRevision)SetImage(bytes);}catch{}}
        if(builtin)pane.Children.Add(T("智能清单外观仅保存在当前设备。",12));
        var save=B("保存",()=>{try{if(!builtin&&string.IsNullOrWhiteSpace(name.Text))throw new InvalidOperationException("请输入清单名称");if(useColor.IsChecked==true&&ValidColor(hex.Text)==null)throw new InvalidOperationException("背景颜色格式为 #RRGGBB");if(fileBytes!=null){bgId=Store.NewId();store.PutFile(bgId,fileBytes);store.Edit("attachment",bgId,new(){["taskId"]="list-bg:"+id,["name"]=filename??"background",["size"]=fileBytes.Length,["type"]=Path.GetExtension(filename??"").ToLowerInvariant() switch{".jpg" or ".jpeg"=>"image/jpeg",".png"=>"image/png",".gif"=>"image/gif",".webp"=>"image/webp",_=>"application/octet-stream"}});}var patch=new JsonObject{["color"]=useColor.IsChecked==true?ValidColor(hex.Text):null,["sort"]=SortOptions[Math.Max(0,sort.SelectedIndex)].Id,["backgroundId"]=bgId,["backgroundOpacity"]=opacity.Value};if(builtin){store.State.Views[id]=patch;store.Save();}else{patch["title"]=name.Text!.Trim();patch["groupId"]=groups[Math.Max(0,group.SelectedIndex)].Id;patch["position"]=a["position"]?.DeepClone()??JsonValue.Create(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());store.Edit("list",id,patch);}Select(id);}catch(Exception e){Status(e.Message);}});
        var cancel=B("取消",()=>{selected="";Refresh();});
        var actions=new List<Control>{save,cancel};
        if(list!=null)actions.Add(B("删除清单（再次确认）",()=>pane.Children.Add(B("确认删除清单",()=>{foreach(var t in store.All("task").Where(t=>Store.Str(t,"listId")==list.Id).ToList())store.DeleteTask(t.Id);store.Edit("list",list.Id,new(),true);Select("inbox");}))));pane.Children.Add(ButtonRow(actions.ToArray()));Resize();ApplyTextSizes();
    }
}
