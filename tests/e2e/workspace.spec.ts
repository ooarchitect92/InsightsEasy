import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
test('browser completes all five synthetic workflow screens',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Create a test workspace'}).click();
 await page.getByLabel('Business name').fill('Browser Fixture');await page.getByLabel('Email address').fill(randomUUID()+'@example.com');await page.getByLabel('Password (12–128 characters)').fill('Browser-fixture-'+randomUUID());await page.getByRole('button',{name:'Create workspace',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Connections & intake'})).toBeVisible();
 async function connection(name:string,provider:string){await page.getByLabel('Connection name').fill(name);await page.getByRole('combobox',{name:/^Capability/}).selectOption(provider);await page.getByRole('button',{name:'Create connection',exact:true}).click();await expect(page.getByText(name,{exact:true}).first()).toBeVisible();}
 await connection('Browser CRM','simulator_crm');
 await page.getByLabel('Connection name').fill('Browser Source');await page.getByRole('combobox',{name:/^Capability/}).selectOption('signed_webhook');await page.getByLabel('Automatic CRM destination').selectOption({label:'Browser CRM'});await page.getByRole('button',{name:'Create connection',exact:true}).click();await expect(page.getByText('Browser Source',{exact:true}).first()).toBeVisible();await page.getByRole('button',{name:'Hide secret'}).click();
 await connection('Browser Website','web_collector');await connection('Browser Ads','simulator_ads');
 await page.getByRole('button',{name:/Acquisition journeys/}).click();
 await page.getByLabel('Observed UTM source').fill('observed-campaign');await page.getByRole('button',{name:'Admit synthetic touch'}).click();await expect(page.getByText('observed-campaign',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:/Leads & CRM/}).click();await page.getByLabel('Explicit collector link').selectOption({label:'Browser Website'});await page.getByRole('button',{name:'Admit synthetic lead'}).click();
 await expect(page.getByText('Example Student',{exact:true})).toBeVisible();await expect(page.locator('tbody .badge.good').filter({hasText:'verified'})).toBeVisible();
 const leadRow=page.getByRole('row').filter({hasText:'Example Student'});await leadRow.getByRole('button',{name:'Open →'}).click();await page.getByLabel('advertising purpose').selectOption('granted');await page.getByLabel('Notice version',{exact:true}).fill('browser-test-v1');await page.getByLabel('Evidence reference',{exact:true}).fill('Synthetic browser approval');await page.getByRole('button',{name:'Save evidenced preferences'}).click();
 await page.getByRole('button',{name:/Revenue & attribution/}).click();await page.getByLabel('Unique business transaction key').fill('browser-order');await page.getByRole('button',{name:'Record business event'}).click();await expect(page.getByText('browser-order',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'Queue report with BullMQ'}).click();await expect(page.getByText('completed',{exact:true}).first()).toBeVisible();
 const reports=page.locator('section').filter({has:page.getByRole('heading',{name:'Published snapshots'})});await reports.getByRole('button',{name:'Open →'}).click();await expect(page.getByRole('link',{name:'Download this snapshot as CSV'})).toBeVisible();
 await page.getByRole('button',{name:/Conversion feedback/}).click();await page.getByRole('button',{name:'Preview — no external effect'}).click();await expect(page.getByText('eligible',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Confirm synthetic activation'}).click();await expect(page.locator('tbody .badge.good').filter({hasText:'verified'})).toBeVisible();
 await page.screenshot({path:'test-results/five-workflows-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'Conversion feedback'})).toBeVisible();await page.screenshot({path:'test-results/five-workflows-mobile.png',fullPage:true});
});
test('website SDK performs no storage or network until consent, and withdrawal aborts collection',async({page})=>{
 await page.goto('/');await page.addScriptTag({url:'/tracker.js'});
 const calls:string[]=[];page.on('request',request=>{if(request.url().includes('/sdk-fixture'))calls.push(request.url());});
 await page.route('**/sdk-fixture/**',route=>route.fulfill({status:202,contentType:'application/json',body:'{"receiptId":"synthetic"}'}));
 await page.evaluate(()=>{
  const root=window as unknown as {InsightsEasyTracker:(x:unknown)=>{track:()=>Promise<unknown>;grant:()=>Promise<unknown>;revoke:()=>void};tracker?:unknown};
  root.tracker=root.InsightsEasyTracker({sourceId:'sdk-test',endpoint:location.origin+'/sdk-fixture'});
 });
 await page.evaluate(()=>((window as unknown as {tracker:{track:()=>Promise<unknown>}}).tracker.track()));expect(calls.length).toBe(0);
 await page.evaluate(()=>((window as unknown as {tracker:{grant:()=>Promise<unknown>}}).tracker.grant()));expect(calls.length).toBe(1);
 await page.evaluate(()=>((window as unknown as {tracker:{revoke:()=>void;track:()=>Promise<unknown>}}).tracker.revoke()));
 await page.evaluate(()=>((window as unknown as {tracker:{track:()=>Promise<unknown>}}).tracker.track()));expect(calls.length).toBe(1);
 expect(await page.evaluate(()=>sessionStorage.getItem('ie-visitor-sdk-test'))).toBeNull();
});
