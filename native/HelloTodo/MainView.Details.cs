using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using System.Globalization;
using System.Text.Json.Nodes;

namespace HelloTodo;

public sealed partial class MainView
{
    private Border DetailSection(params Control[] controls)
    {
        var stack=new StackPanel{Spacing=8};
        foreach(var control in controls)stack.Children.Add(control);
        return new Border{Background=SurfaceBrush(),CornerRadius=new CornerRadius(4),Padding=new Thickness(11),Child=stack,HorizontalAlignment=HorizontalAlignment.Stretch};
    }

    private Button DetailIcon(string text,string hint,Action action)
    {
        var button=B(text,action);
        button.HorizontalAlignment=HorizontalAlignment.Center;
        button.HorizontalContentAlignment=HorizontalAlignment.Center;
        button.VerticalAlignment=VerticalAlignment.Center;
        button.FontSize=22;
        button.Padding=new Thickness(4);
        button.MinWidth=30;
        ToolTip.SetTip(button,hint);
        Avalonia.Automation.AutomationProperties.SetName(button,hint);
        return button;
    }

    private void Details()
    {
        pane.Children.Clear();
        var task=store.Get("task",selected);
        if(task==null){selected="";return;}
        var id=task.Id;

        var titleRow=new Grid{ColumnDefinitions=new("Auto,*,Auto")};
        Put(titleRow,DetailIcon(Store.Bool(task,"completed")?"✓":"○","切换完成状态",()=>{store.Complete(task,!Store.Bool(task,"completed"));Refresh();}),0);
        var title=Box(Store.Str(task,"title"),"任务名称",value=>{if(!string.IsNullOrWhiteSpace(value))Patch(id,"title",value.Trim());});
        title.FontSize=16;title.FontWeight=FontWeight.SemiBold;
        title.BorderThickness=new Thickness(0);title.Background=Brushes.Transparent;
        Put(titleRow,title,1);
        Put(titleRow,DetailIcon(Store.Bool(task,"important")?"★":"☆","切换重要状态",()=>Patch(id,"important",!Store.Bool(task,"important"),true)),2);
        pane.Children.Add(DetailSection(titleRow));

        var steps=new StackPanel{Spacing=5};
        foreach(var step in store.All("step").Where(s=>Store.Str(s,"taskId")==id).OrderBy(s=>double.TryParse(Store.Str(s,"position"),NumberStyles.Float,CultureInfo.InvariantCulture,out var position)?position:0).ToList())
        {
            var row=new Grid{ColumnDefinitions=new("Auto,*,Auto")};
            var check=new CheckBox{IsChecked=Store.Bool(step,"completed"),VerticalAlignment=VerticalAlignment.Center,MinWidth=24};
            Avalonia.Automation.AutomationProperties.SetName(check,"完成步骤 "+Store.Str(step,"title"));
            check.Click+=(_,_)=>{store.Edit("step",step.Id,new(){["completed"]=check.IsChecked==true});Status();};
            Put(row,check,0);
            var stepTitle=Box(Store.Str(step,"title"),"步骤",value=>store.Edit("step",step.Id,new(){["title"]=value}));
            stepTitle.BorderThickness=new Thickness(0);stepTitle.Background=Brushes.Transparent;
            Put(row,stepTitle,1);
            Put(row,DetailIcon("×","删除步骤",()=>{store.Edit("step",step.Id,new(),true);Refresh();}),2);
            steps.Children.Add(row);
        }
        var newStep=Box(null,"＋ 添加步骤");
        void AddStep()
        {
            if(string.IsNullOrWhiteSpace(newStep.Text))return;
            store.Edit("step",Store.NewId(),new(){["title"]=newStep.Text.Trim(),["taskId"]=id,["completed"]=false,["position"]=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
            Refresh();
        }
        newStep.KeyDown+=(_,e)=>{if(e.Key==Key.Enter){AddStep();e.Handled=true;}};
        steps.Children.Add(newStep);steps.Children.Add(B("添加步骤",AddStep));
        pane.Children.Add(DetailSection(steps));
        pane.Children.Add(DetailSection(B(Store.Str(task,"myDay")==Store.Today()?"☼ 已添加到“我的一天” ×":"☼ 添加到“我的一天”",()=>Patch(id,"myDay",Store.Str(task,"myDay")==Store.Today()?null:JsonValue.Create(Store.Today()),true))));

        // Match the Web fields while using native date/time pickers in the local time zone.
        var reminderRow=new StackPanel{Spacing=4};
        var reminderDate=new CalendarDatePicker{Watermark="选择日期",HorizontalAlignment=HorizontalAlignment.Stretch};
        var reminderTime=new TimePicker{ClockIdentifier="24HourClock",HorizontalAlignment=HorizontalAlignment.Stretch};
        if(DateTimeOffset.TryParse(Store.Str(task,"reminder"),out var reminder))
        {
            reminderDate.SelectedDate=reminder.LocalDateTime.Date;
            reminderTime.SelectedTime=reminder.LocalDateTime.TimeOfDay;
        }
        void SaveReminder()
        {
            if(reminderDate.SelectedDate is not { } date){Patch(id,"reminder",null);return;}
            var local=DateTime.SpecifyKind(date.Date+(reminderTime.SelectedTime??TimeSpan.FromHours(9)),DateTimeKind.Unspecified);
            if(DateTimeOffset.TryParse(Store.Str(store.Get("task",id),"reminder"),out var current))
            {
                var previous=current.LocalDateTime;
                if(previous.Date==local.Date&&previous.Hour==local.Hour&&previous.Minute==local.Minute)return;
            }
            if(TimeZoneInfo.Local.IsInvalidTime(local)){Status("此提醒时间因夏令时调整不存在，请选择其他时间");return;}
            Patch(id,"reminder",new DateTimeOffset(local,TimeZoneInfo.Local.GetUtcOffset(local)).ToUniversalTime().ToString("O"));
        }
        reminderDate.SelectedDateChanged+=(_,_)=>SaveReminder();
        reminderTime.SelectedTimeChanged+=(_,_)=>SaveReminder();
        reminderRow.Children.Add(reminderDate);reminderRow.Children.Add(reminderTime);
        var reminderPanel=new StackPanel{Spacing=4};reminderPanel.Children.Add(reminderRow);
        reminderPanel.Children.Add(B("清除提醒",()=>Patch(id,"reminder",null,true)));

        var due=new CalendarDatePicker{Watermark="选择截止日期",HorizontalAlignment=HorizontalAlignment.Stretch};
        if(DateTime.TryParse(Store.Str(task,"due"),out var dueDate))due.SelectedDate=dueDate;
        due.SelectedDateChanged+=(_,_)=>Patch(id,"due",due.SelectedDate?.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture));
        var duePanel=new StackPanel{Spacing=4};duePanel.Children.Add(due);duePanel.Children.Add(B("清除截止日期",()=>Patch(id,"due",null,true)));

        var repeatValues=new List<string>{"","daily","weekdays","weekly","monthly","yearly"};
        var repeatLabels=new List<string>{"不重复","每天","工作日","每周","每月","每年"};
        var repeatValue=task.Data["repeat"] is JsonObject rule?rule["pattern"]?["type"]?.ToString()??"":Store.Str(task,"repeat");
        if(!repeatValues.Contains(repeatValue)){repeatValues.Add(repeatValue);repeatLabels.Add("已导入的自定义规则");}
        var repeat=new ComboBox{ItemsSource=repeatLabels,SelectedIndex=repeatValues.IndexOf(repeatValue),HorizontalAlignment=HorizontalAlignment.Stretch};
        repeat.SelectionChanged+=(_,_)=>{if(repeat.SelectedIndex>=0){var value=repeatValues[repeat.SelectedIndex];if(value==repeatValue)return;repeatValue=value;Patch(id,"repeat",value==""?null:JsonValue.Create(value));}};
        var lists=new List<Record>{new("list","inbox",new(){["title"]="任务"})};lists.AddRange(store.All("list"));
        var destination=new ComboBox{ItemsSource=lists.Select(x=>Store.Str(x,"title")).ToArray(),SelectedIndex=lists.FindIndex(x=>x.Id==Store.Str(task,"listId")),HorizontalAlignment=HorizontalAlignment.Stretch};
        destination.SelectionChanged+=(_,_)=>{if(destination.SelectedIndex>=0)Patch(id,"listId",lists[destination.SelectedIndex].Id);};
        pane.Children.Add(DetailSection(Labelled("◷ 提醒我",reminderPanel),Labelled("▦ 添加截止日期",duePanel),Labelled("↻ 重复",repeat),Labelled("☷ 移动到清单",destination)));

        var files=new StackPanel{Spacing=5};files.Children.Add(T("附件"+(store.AttachmentStatus(task).Pending?" · 待补齐":""),12));
        foreach(var attachment in store.All("attachment").Where(a=>Store.Str(a,"taskId")==id).ToList())
        {
            var row=new Grid{ColumnDefinitions=new("*,Auto")};
            var open=B("📎 "+Store.Str(attachment,"name"),async()=>await SaveAttachment(attachment));
            open.Content=T("📎 "+Store.Str(attachment,"name"));open.HorizontalContentAlignment=HorizontalAlignment.Stretch;
            Put(row,open,0);Put(row,DetailIcon("×","移除附件",()=>{store.Edit("attachment",attachment.Id,new(),true);Refresh();}),1);
            files.Children.Add(row);
        }
        files.Children.Add(B("＋ 添加文件",async()=>await PickFiles(id)));
        foreach(var link in store.All("link").Where(l=>Store.Str(l,"taskId")==id))
        {
            if(!Uri.TryCreate(Store.Str(link,"url"),UriKind.Absolute,out var uri)||uri.Scheme is not ("http" or "https"))continue;
            var open=B(Store.Str(link,"title",uri.Host),async()=>{try{var launcher=TopLevel.GetTopLevel(this)?.Launcher;if(launcher!=null)await launcher.LaunchUriAsync(uri);}catch(Exception error){Status(error.Message);}});
            open.Content=T(Store.Str(link,"title",uri.Host));open.HorizontalContentAlignment=HorizontalAlignment.Stretch;files.Children.Add(open);
        }
        pane.Children.Add(DetailSection(files));
        var notes=Box(Store.Str(task,"notes"),"添加备注",value=>Patch(id,"notes",value));
        notes.AcceptsReturn=true;notes.MinHeight=105;notes.TextWrapping=TextWrapping.Wrap;notes.BorderThickness=new Thickness(0);
        pane.Children.Add(DetailSection(notes));

        var footer=new Grid{ColumnDefinitions=new("Auto,*,Auto")};
        Put(footer,B("‹ 返回",()=>{selected="";Refresh();}),0);
        var created=Store.Str(task,"createdAt");if(DateTimeOffset.TryParse(created,out var createdAt))created=createdAt.ToString("yyyy-MM-dd");
        var createdText=T("创建于 "+created,11);createdText.HorizontalAlignment=HorizontalAlignment.Center;Put(footer,createdText,1);
        var delete=B("删除任务",()=>ConfirmDelete(id));delete.Foreground=Brush.Parse(Dark?"#ff9a92":"#c42b1c");Put(footer,delete,2);
        detailFooter.Child=footer;detailFooter.IsVisible=true;
    }
}
