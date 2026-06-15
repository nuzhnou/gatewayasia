const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * Публикация рекламного текста в конкретную группу Facebook
 * @param {string} groupUrl - URL группы Facebook
 * @param {string} adText - Текст для публикации
 * @param {boolean} headless - Запускать ли в headless режиме
 */
async function postToFacebookGroup(groupUrl, adText, headless = true) {
  const cookiesPath = path.join(__dirname, '../../facebook_cookies.json');
  if (!fs.existsSync(cookiesPath)) {
    console.error(`[FB POSTER] Error: facebook_cookies.json not found at ${cookiesPath}`);
    console.error("Пожалуйста, экспортируйте ваши куки Facebook и сохраните их в этот файл в формате JSON массива.");
    return { success: false, error: "Missing facebook_cookies.json file" };
  }

  let cookies;
  try {
    cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  } catch (err) {
    console.error("[FB POSTER] Error reading/parsing facebook_cookies.json:", err);
    return { success: false, error: "Invalid facebook_cookies.json format" };
  }

  console.log(`[FB POSTER] Launching browser (headless: ${headless})...`);
  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications', // Отключение всплывающих уведомлений ФБ
      '--window-size=1280,800'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  // Устанавливаем стандартный User-Agent, чтобы избежать блокировок
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    console.log("[FB POSTER] Injecting Facebook cookies...");
    const formattedCookies = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
      path: c.path || '/',
      secure: c.secure !== undefined ? c.secure : true,
      httpOnly: c.httpOnly !== undefined ? c.httpOnly : true
    }));

    await page.setCookie(...formattedCookies);

    console.log(`[FB POSTER] Navigating to group: ${groupUrl}...`);
    await page.goto(groupUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Проверяем, авторизованы ли мы
    if (page.url().includes('login.php') || await page.$('input[name="email"]')) {
      throw new Error("Cookies are invalid or expired. Facebook redirected to login page.");
    }

    console.log("[FB POSTER] Checking for 'Create Post' box...");
    
    // Ждем прогрузки страницы
    await new Promise(r => setTimeout(r, 3000));

    // Кликаем по кнопке создания поста. Используем evaluate для поиска по тексту на разных языках
    const clickResult = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('span, div[role="button"]'));
      const targets = [
        "write something", "напишите что-нибудь", "napisz coś", 
        "create a public post", "создайте общедоступную публикацию", "utwórz post publiczny"
      ];
      
      for (const el of elements) {
        const txt = (el.innerText || el.textContent || "").toLowerCase().trim();
        if (targets.some(t => txt.includes(t))) {
          // Ищем родительский элемент с ролью button (если он есть)
          let btn = el;
          while (btn && btn.getAttribute('role') !== 'button' && btn.tagName !== 'BODY') {
            btn = btn.parentElement;
          }
          if (btn) {
            btn.click();
            return true;
          }
          el.click();
          return true;
        }
      }
      return false;
    });

    if (clickResult) {
      console.log("[FB POSTER] Successfully clicked create post element!");
    } else {
      console.log("[FB POSTER] Text matching failed. Attempting fallback selectors...");
      // Пробуем кликнуть по первому подходящему блоку, который выглядит как инпут создания поста
      const textboxes = await page.$$('div[role="button"]');
      let clicked = false;
      for (const box of textboxes) {
        const text = await page.evaluate(el => el.textContent, box);
        if (text && text.length > 5 && text.length < 50) {
          await box.click();
          clicked = true;
          console.log("[FB POSTER] Clicked fallback button container.");
          break;
        }
      }
      if (!clicked) {
        throw new Error("Could not find 'Create Post' trigger button on the Facebook page.");
      }
    }

    // Ждем открытия модалки
    console.log("[FB POSTER] Waiting for editor textbox...");
    const textboxSelector = 'div[role="textbox"], div[contenteditable="true"]';
    await page.waitForSelector(textboxSelector, { timeout: 15000 });
    
    console.log("[FB POSTER] Typing post content...");
    await page.click(textboxSelector);
    await page.type(textboxSelector, adText);
    
    // Имитируем небольшую задержку
    await new Promise(r => setTimeout(r, 3000));

    console.log("[FB POSTER] Submitting the post...");
    // Ищем кнопку Опубликовать / Post / Opublikuj
    const postBtnClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('div[role="button"], span'));
      const targets = ["post", "опубликовать", "opublikuj"];
      
      for (const btn of buttons) {
        const txt = (btn.innerText || btn.textContent || "").toLowerCase().trim();
        if (targets.includes(txt)) {
          let clickTarget = btn;
          if (btn.tagName === 'SPAN') {
            clickTarget = btn.closest('div[role="button"]') || btn;
          }
          clickTarget.click();
          return true;
        }
      }
      return false;
    });

    if (!postBtnClicked) {
      console.log("[FB POSTER] Text search for submit button failed. Using standard CSS selectors...");
      const submitSelector = 'div[aria-label="Post"], div[aria-label="Опубликовать"], div[aria-label="Opublikuj"]';
      await page.waitForSelector(submitSelector, { timeout: 5000 });
      await page.click(submitSelector);
    }

    // Ожидаем завершения публикации
    console.log("[FB POSTER] Waiting for publication to complete...");
    await new Promise(r => setTimeout(r, 8000));

    console.log("[FB POSTER] Publication process finished!");
    await browser.close();
    return { success: true };

  } catch (error) {
    console.error("[FB POSTER] Posting failed with error:", error);
    
    // Сохраняем скриншот для отладки
    const errorScreenshotPath = path.join(__dirname, '../../artifacts/fb_post_error.png');
    console.log(`[FB POSTER] Saving debug screenshot to: ${errorScreenshotPath}`);
    try {
      const artifactsDir = path.dirname(errorScreenshotPath);
      if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
      }
      await page.screenshot({ path: errorScreenshotPath });
    } catch (ssErr) {
      console.error("[FB POSTER] Failed to capture debug screenshot:", ssErr);
    }
    
    await browser.close();
    return { success: false, error: error.message };
  }
}

module.exports = {
  postToFacebookGroup
};
