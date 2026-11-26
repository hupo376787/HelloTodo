using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using System.Runtime.InteropServices;

namespace HelloTodo;

public static class AppBranding
{
    public static readonly string[] Colors={"#3b82f6","#79b4df","#61b9aa","#8cbb7a","#b0bc66","#e6bd67","#e9a17c","#e08ca1","#d798c5","#b39be1","#9a90d1","#c5a68d","#9eafbd"};
    public static readonly string[] PreviousColors={"#2564cf","#7695ad","#6e9e98","#879c83","#969b70","#c0a46c","#c18f75","#b9818b","#b397aa","#9990b7","#807b9e","#9c8c80","#87949d"};
    public static Action<int>? ChangeLauncherIcon {get;set;}
    public static Action<byte[]>? ChangeDockIcon {get;set;}
    public static int Closest(Color color)=>Enumerable.Range(0,Colors.Length).MinBy(i=>{var c=Color.Parse(Colors[i]);return Math.Pow(color.R-c.R,2)+Math.Pow(color.G-c.G,2)+Math.Pow(color.B-c.B,2);});
    public static DrawingImage Drawing(Color color)
    {
        var group=new DrawingGroup();
        foreach(var (path,light) in new[]{("M4 30 14 20 28 34 18 44Z",false),("M4 30 14 20 28 34 50 12 60 22 28 54Z",false),("M18 44 50 12 60 22 28 54Z",true)})
        {
            var c=light?Color.FromRgb((byte)Math.Round(color.R+(255-color.R)*.3),(byte)Math.Round(color.G+(255-color.G)*.3),(byte)Math.Round(color.B+(255-color.B)*.3)):color;
            group.Children.Add(new GeometryDrawing{Geometry=Geometry.Parse(path),Brush=new SolidColorBrush(c)});
        }
        return new DrawingImage(group);
    }
    public static WriteableBitmap Bitmap(Color color)
    {
        const int size=64;
        var image=new WriteableBitmap(new PixelSize(size,size),new Vector(96,96),PixelFormat.Bgra8888,AlphaFormat.Premul);
        var shapes=new[]{new[]{(4d,30d),(14d,20d),(28d,34d),(18d,44d)},new[]{(4d,30d),(14d,20d),(28d,34d),(50d,12d),(60d,22d),(28d,54d)},new[]{(18d,44d),(50d,12d),(60d,22d),(28d,54d)}};
        static bool Inside((double X,double Y)[] points,double x,double y){bool inside=false;for(int i=0,j=points.Length-1;i<points.Length;j=i++)if((points[i].Y>y)!=(points[j].Y>y)&&x<(points[j].X-points[i].X)*(y-points[i].Y)/(points[j].Y-points[i].Y)+points[i].X)inside=!inside;return inside;}
        using var buffer=image.Lock();var bytes=new byte[buffer.RowBytes*size];
        for(int y=0;y<size;y++)for(int x=0;x<size;x++)
        {
            double red=0,green=0,blue=0,alpha=0;
            for(int sy=0;sy<4;sy++)for(int sx=0;sx<4;sx++)
            {
                var px=x+(sx+.5)/4;var py=y+(sy+.5)/4;int shape=-1;
                for(int i=0;i<shapes.Length;i++)if(Inside(shapes[i],px,py))shape=i;
                if(shape<0)continue;alpha++;var light=shape==2?.3:0;
                red+=color.R+(255-color.R)*light;green+=color.G+(255-color.G)*light;blue+=color.B+(255-color.B)*light;
            }
            int n=y*buffer.RowBytes+x*4;bytes[n]=(byte)Math.Round(blue/16);bytes[n+1]=(byte)Math.Round(green/16);bytes[n+2]=(byte)Math.Round(red/16);bytes[n+3]=(byte)Math.Round(alpha*255/16);
        }
        Marshal.Copy(bytes,0,buffer.Address,bytes.Length);return image;
    }
}

public sealed partial class MainView
{
    private readonly Image appLogo=new(){Width=32,Height=32,Margin=new Thickness(3)};
    private string appliedIcon="";
    private Window? iconWindow;
    private void UpdateAppIcon()
    {
        var accent=Accent.ToString();var window=TopLevel.GetTopLevel(this) as Window;
        if(accent==appliedIcon&&window==iconWindow)return;
        appLogo.Source=AppBranding.Drawing(Accent);appliedIcon=accent;iconWindow=window;
        AppBranding.ChangeLauncherIcon?.Invoke(AppBranding.Closest(Accent));
        if((window==null||Application.Current?.ApplicationLifetime is not Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime)&&AppBranding.ChangeDockIcon==null)return;
        try
        {
            using var bitmap=AppBranding.Bitmap(Accent);
            if(window!=null)window.Icon=new WindowIcon(bitmap);
            if(AppBranding.ChangeDockIcon!=null){using var stream=new MemoryStream();bitmap.Save(stream);AppBranding.ChangeDockIcon(stream.ToArray());}
        }
        catch(NotSupportedException){/* Headless drawing does not expose OS icons. */}
    }
}
