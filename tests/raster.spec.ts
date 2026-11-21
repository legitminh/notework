import { test, expect, type Page, type Locator } from '@playwright/test';
import { sizeCanvas, rasterPoint, alpha } from './raster-helpers';
const button = (page:Page,name:string) => page.getByRole('button',{name,exact:true});
async function create(page:Page,name:string,kind='png') {
  await page.goto('/'); await button(page,'app settings').click(); await button(page,'create new file/folder').click();
  await page.getByLabel('name',{exact:true}).fill(name); await button(page,`create ${kind} image`).click();
}
async function drag(page:Page,canvas:Locator,points:number[][]) {
  for (const [i,p] of points.entries()) { const at=await rasterPoint(canvas,p[0],p[1]);await page.mouse.move(at.x,at.y,{steps:i?5:1});if(!i)await page.mouse.down(); } await page.mouse.up();
}
async function imported(page:Page) {
  await page.goto('/');await button(page,'app settings').click();await button(page,'create new file/folder').click();
  await page.getByLabel('name',{exact:true}).fill('pixels.txt');await button(page,'create text file').click();await page.locator('[data-action="open"] button').click();
  const data=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=400;c.height=200;const ctx=c.getContext('2d')!;ctx.fillStyle='red';ctx.fillRect(0,0,400,200);return [...new Uint8Array(await(await new Promise<Blob>(r=>c.toBlob(b=>r(b!)))).arrayBuffer())]});
  await page.getByLabel('Image file to insert').setInputFiles({name:'pixels.png',mimeType:'image/png',buffer:Buffer.from(data)});
  const canvas=page.getByRole('img',{name:/Drawing canvas for pixels-.*\.png/});await expect(canvas.locator('canvas')).toBeVisible();return canvas;
}
test('new raster dimensions use viewport initially, validate, remember, and keep canvas visible at minimum zoom',async({page})=>{
  await create(page,'sized.png');
  const viewport=page.viewportSize()!;
  await expect(page.getByLabel('Width in pixels')).toHaveValue(String(viewport.width));await expect(page.getByLabel('Height in pixels')).toHaveValue(String(viewport.height));
  await page.getByLabel('Width in pixels').fill('0');await expect(button(page,'Create canvas')).toBeDisabled();
  await page.getByLabel('Width in pixels').fill('400');await page.getByLabel('Height in pixels').fill('200');await page.getByLabel('Height in pixels').press('Enter');await page.locator('[data-action="open"] button').click();
  const canvas=page.getByRole('img',{name:'Drawing canvas for sized.png'});await expect(canvas.locator('canvas')).toBeVisible();
  await canvas.hover();for(let i=0;i<15;i++)await page.mouse.wheel(0,1000);
  await expect.poll(async()=>Number(await canvas.getAttribute('data-raster-zoom'))*400).toBeCloseTo(await page.evaluate(()=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--min-box'))),0);
  await button(page,'Pan').click();const box=(await canvas.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width+1000,box.y-1000);await page.mouse.up();
  expect(await canvas.evaluate(node=>{const view=(node as unknown as {visualView:{toScreen(x:number,y:number):[number,number]}}).visualView,a=node.getBoundingClientRect(),[l,t]=view.toScreen(0,0),[r,b]=view.toScreen(400,200);return a.left+r>a.left&&a.left+l<a.right&&a.top+b>a.top&&a.top+t<a.bottom})).toBe(true);
  await button(page,'Exit').click();await button(page,'home').click();await create(page,'remember.png');
  await expect(page.getByLabel('Width in pixels')).toHaveValue('400');await expect(page.getByLabel('Height in pixels')).toHaveValue('200');
});
test('lasso deletes only enclosed imported pixels; undo and redo restore the operation',async({page})=>{
  const canvas=await imported(page);await button(page,'Lasso').click();
  await drag(page,canvas,[[100,50],[200,50],[200,150],[100,150],[100,50]]);
  await button(page,'Clear selected pixels').click();expect(await alpha(canvas,150,100)).toBe(0);expect(await alpha(canvas,99,100)).toBe(255);expect(await alpha(canvas,250,100)).toBe(255);
  await button(page,'Undo').click();expect(await alpha(canvas,150,100)).toBe(255);await button(page,'Redo').click();expect(await alpha(canvas,150,100)).toBe(0);
  await button(page,'Exit').click();await expect(page.getByRole('textbox',{name:'Edit pixels.txt'})).toBeVisible();
});
test('lasso moves and resizes pixels within its bounds and preserves surrounding pixels',async({page})=>{
  const canvas=await imported(page);await button(page,'Lasso').click();
  await drag(page,canvas,[[100,50],[200,50],[200,150],[100,150],[100,50]]);
  await drag(page,canvas,[[150,100],[250,100]]);
  expect(await alpha(canvas,150,100)).toBe(0);expect(await alpha(canvas,250,100)).toBe(255);expect(await alpha(canvas,50,100)).toBe(255);
  await button(page,'Undo').click();expect(await alpha(canvas,150,100)).toBe(255);
  await drag(page,canvas,[[100,50],[200,50],[200,150],[100,150],[100,50]]);
  await drag(page,canvas,[[200,150],[150,100]]);
  expect(await alpha(canvas,175,125)).toBe(0);expect(await alpha(canvas,125,75)).toBe(255);expect(await alpha(canvas,250,100)).toBe(255);
  await button(page,'Undo').click();expect(await alpha(canvas,175,125)).toBe(255);
});
test('ORA uses pixel layers with undo across layer switches and layer operations',async({page})=>{
  await create(page,'layered.ora','ora');await sizeCanvas(page,400,200);await page.locator('[data-action="open"] button').click();
  const canvas=page.getByRole('img',{name:'Drawing canvas for layered.ora'});await expect(canvas.locator('canvas')).toBeVisible();
  await drag(page,canvas,[[50,50],[150,50]]);expect(await alpha(canvas,100,50)).toBe(255);
  await button(page,'Add layer').click();expect(await alpha(canvas,100,50)).toBe(0);await drag(page,canvas,[[50,100],[150,100]]);
  await button(page,'Undo').click();expect(await alpha(canvas,100,100)).toBe(0);await button(page,'Undo').click();await expect(page.locator('[data-choice="active layer"]')).toBeVisible();expect(await canvas.evaluate(node=>(node as unknown as {visualEditor:{layers:unknown[]}}).visualEditor.layers.length)).toBe(1);expect(await alpha(canvas,100,50)).toBe(255);
  await button(page,'Undo').click();expect(await alpha(canvas,100,50)).toBe(0);await button(page,'Redo').click();expect(await alpha(canvas,100,50)).toBe(255);
});

test('raster touch taps undo/redo while a pinch with one stationary finger preserves ink',async({page,context})=>{
  await create(page,'gestures.png');await sizeCanvas(page,400,200);await page.locator('[data-action="open"] button').click();
  const canvas=page.getByRole('img',{name:'Drawing canvas for gestures.png'});await expect(canvas.locator('canvas')).toBeVisible();
  await drag(page,canvas,[[50,50],[150,50]]);
  const cdp=await context.newCDPSession(page),frame=(await canvas.boundingBox())!;
  // Real touch input (pointer and touch events), as on a tablet.
  const tap=async(count:number)=>{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:Array.from({length:count},(_,i)=>({id:i+1,x:frame.x+30+i*30,y:frame.y+30}))});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await tap(2);expect(await alpha(canvas,100,50)).toBe(0);await tap(3);expect(await alpha(canvas,100,50)).toBe(255);
  const before=Number(await canvas.getAttribute('data-raster-zoom')),box=(await canvas.boundingBox())!,protocol=await context.newCDPSession(page);
  const a={id:1,x:box.x+100,y:box.y+80},b={id:2,x:box.x+200,y:box.y+80};
  await protocol.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a,b]});
  await protocol.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[a,{...b,x:b.x+50}]});
  await protocol.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  expect(Number(await canvas.getAttribute('data-raster-zoom'))).toBeGreaterThan(before);expect(await alpha(canvas,100,50)).toBe(255);
});
