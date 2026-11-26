"""Build platform icon resources from the shared checkmark geometry and theme palette."""
from pathlib import Path
import json
import re
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[1]
source=(ROOT/'web/branding.mjs').read_text(encoding='utf-8')
colors=re.search(r'BRIGHT_ACCENTS=\[(.*?)\]',source).group(1).replace("'",'"')
colors=json.loads('['+colors+']')
polygons=[[(4,30),(14,20),(28,34),(18,44)],[(4,30),(14,20),(28,34),(50,12),(60,22),(28,54)],[(18,44),(50,12),(60,22),(28,54)]]

def icon(color,size=256,background=False):
    factor=4
    image=Image.new('RGBA',(size*factor,size*factor),'white' if background else (0,0,0,0))
    draw=ImageDraw.Draw(image)
    rgb=tuple(int(color[i:i+2],16) for i in (1,3,5))
    for i,points in enumerate(polygons):
        fill=tuple(round(x+(255-x)*.3) for x in rgb) if i==2 else rgb
        draw.polygon([(round(x*size*factor/64),round(y*size*factor/64)) for x,y in points],fill=fill)
    return image.resize((size,size),Image.Resampling.LANCZOS)

def generate():
    paths=['M'+' '.join(f'{x} {y}' for x,y in polygon)+'Z' for polygon in polygons]
    svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'+''.join(f'<path d="{path}" fill="{colors[0] if i<2 else "white"}"'+(' opacity=".30"' if i==2 else '')+'/>' for i,path in enumerate(paths))+'</svg>'
    (ROOT/'web/icon.svg').write_text(svg,encoding='utf-8',newline='\n')
    assets=ROOT/'native/HelloTodo/Assets';assets.mkdir(exist_ok=True)
    icon(colors[0]).save(assets/'app.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    icon(colors[0],512).save(assets/'app.png')
    icon(colors[0],1024).save(assets/'app.icns')
    android=ROOT/'native/HelloTodo.Android/Resources/drawable';android.mkdir(parents=True,exist_ok=True)
    ios=ROOT/'native/HelloTodo.iOS/Resources';ios.mkdir(exist_ok=True)
    for i,color in enumerate(colors):
        name='theme'+str(i)
        icon(color,192,True).save(android/('icon_'+name+'.png'))
        for size,suffix in [(120,'60@2x'),(180,'60@3x'),(152,'76@2x'),(167,'83.5@2x')]:
            icon(color,size,True).save(ios/(name+'-'+suffix+'.png'))
    # The PWA manifest points at real PNG sizes; browsers do not consistently accept SVG install icons.
    for size in (192,512):icon(colors[0],size,True).save(ROOT/'web'/f'icon-{size}.png')

if __name__=='__main__':generate()
