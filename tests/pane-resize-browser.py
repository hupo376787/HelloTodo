"""Desktop splitter E2E; uses disposable local data, never the user's database."""
import os, subprocess, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as tmp:
    env={**os.environ,'HELLOTODO_KEY':'A'*43,'HELLOTODO_DB':tmp+'/test.sqlite','HELLOTODO_FILES':tmp+'/files','PORT':'18787'}
    server=subprocess.Popen(['node','server/local.mjs'],cwd=root,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        url='http://localhost:18787'
        for _ in range(60):
            try: urllib.request.urlopen(url+'/api/health');break
            except Exception: time.sleep(.1)
        else: raise RuntimeError('Local server unavailable')
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None,args=['--no-sandbox'],headless=True)
            page=browser.new_page(viewport={'width':1400,'height':900});page.goto(url);page.get_by_text('新建清单',exact=False).wait_for()
            def width(id): return page.locator(id).bounding_box()['width']
            def drag(id,dx):
                b=page.locator(id).bounding_box();x=b['x']+b['width']/2;y=b['y']+b['height']/2
                page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+dx,y,steps=8);page.mouse.up()
            assert not page.locator('#detail-resizer').is_visible()
            drag('#sidebar-resizer',100);assert width('#sidebar')==360
            page.locator('#newTask').fill('测试拖拽');page.locator('#newTask').press('Enter');page.get_by_role('button',name='测试拖拽',exact=True).click()
            drag('#detail-resizer',-100);assert width('#detail')==445;assert width('#sidebar')==360
            page.locator('#detail-resizer').focus();page.keyboard.press('ArrowLeft');assert width('#detail')==455
            page.reload();page.get_by_role('button',name='测试拖拽',exact=True).click();assert width('#sidebar')==360 and width('#detail')==455
            page.locator('#hamburger').click();assert not page.locator('#sidebar-resizer').is_visible();page.locator('#hamburger').click();assert width('#sidebar')==360
            page.set_viewport_size({'width':800,'height':900});page.wait_for_timeout(200);assert width('#main')>=280
            page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200);assert not page.locator('#sidebar-resizer').is_visible() and not page.locator('#detail-resizer').is_visible();assert width('#detail')==390
            page.set_viewport_size({'width':1400,'height':900});page.wait_for_timeout(200);assert width('#sidebar')==360 and width('#detail')==455
            page.locator('#detail-resizer').dblclick();assert width('#detail')==345
            page.locator('#detail').get_by_label('返回任务列表').click();assert not page.locator('#detail-resizer').is_visible()
            browser.close()
        print('PASS: desktop drag, width persistence, keyboard, visibility, narrow viewport, reset')
    finally:
        server.terminate();server.wait(timeout=10)
