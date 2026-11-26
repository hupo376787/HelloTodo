using Avalonia;
using Avalonia.Controls;
using Avalonia.LogicalTree;
using System.Runtime.CompilerServices;

namespace HelloTodo;

public sealed partial class MainView
{
    private sealed record FontBaseline(double Size);
    private readonly ConditionalWeakTable<Control,FontBaseline> textBaselines=new();
    private double TextScale=>double.IsFinite(store.State.TextScale)?Math.Clamp(store.State.TextScale,.8,1.6):1;
    private void ApplyTextSizes()
    {
        // Logical children exclude the theme's internal text presenters, so inherited text is scaled once.
        var controls=this.GetLogicalDescendants().OfType<Control>().Where(c=>c is TextBlock or Button or TextBox or ComboBox or CheckBox or Expander or CalendarDatePicker or TimePicker).ToArray();
        foreach(var control in controls)
        {
            var size=control is TextBlock text?text.FontSize:((Avalonia.Controls.Primitives.TemplatedControl)control).FontSize;
            textBaselines.GetValue(control,_=>new FontBaseline(size));
        }
        foreach(var control in controls)
        {
            var size=textBaselines.GetValue(control,_=>new FontBaseline(14)).Size*TextScale;
            if(control is TextBlock text)text.FontSize=size;
            else ((Avalonia.Controls.Primitives.TemplatedControl)control).FontSize=size;
        }
        if(Content is Grid layers&&layers.Children.FirstOrDefault() is Grid root&&root.RowDefinitions.Count==3)root.RowDefinitions[2].Height=new GridLength(Math.Max(23,23*TextScale));
    }
    private Control TextSizeSetting()
    {
        var value=T($"全局文字大小：{TextScale*100:0}%",12);
        var slider=new Slider{Minimum=80,Maximum=160,Value=TextScale*100,TickFrequency=5,IsSnapToTickEnabled=true,HorizontalAlignment=Avalonia.Layout.HorizontalAlignment.Stretch};
        Avalonia.Automation.AutomationProperties.SetName(slider,"全局文字大小");
        slider.PropertyChanged+=(_,e)=>{if(e.Property!=Slider.ValueProperty)return;ApplyTextSizes();store.State.TextScale=slider.Value/100;store.Save();value.Text=$"全局文字大小：{slider.Value:0}%";ApplyTextSizes();};
        var panel=new StackPanel{Spacing=6};panel.Children.Add(value);panel.Children.Add(slider);
        panel.Children.Add(B("恢复默认字号",()=>slider.Value=100));return panel;
    }
}
