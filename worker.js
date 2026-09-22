export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const token =
      env.BALE_TOKEN ||
      env.BALE_BOT_TOKEN ||
      env.BOT_TOKEN;
    if (request.method === "GET" && url.pathname === "/debug") {
      if (!token) {
        return new Response("TOKEN NOT FOUND", { status: 500 });
      }

      const r = await fetch(
        `https://tapi.bale.ai/bot${token}/getWebhookInfo`
      );

      const text = await r.text();

      return new Response(text, {
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
        },
      });
    }
    // تست سلامت ربات
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Rekord Mehr Bot is running ✅", {
        status: 200,
      });
    }

    // تنظیم Webhook بله
    if (request.method === "GET" && url.pathname === "/setup") {
      if (!token) {
        return new Response("BALE TOKEN NOT FOUND", { status: 500 });
      }

      const webhookUrl = `${url.origin}/webhook`;

      const response = await fetch(
        `https://tapi.bale.ai/bot${token}/setWebhook`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: webhookUrl,
          }),
        }
      );

      const result = await response.text();

      return new Response(result, {
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
        },
      });
    }

    // دریافت پیام از بله
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();

        const msg = update.message;
        if (!msg) {
          return new Response("OK");
        }

        const chatId = msg.chat?.id;
        const userId = msg.from?.id;
        const firstName = msg.from?.first_name || "";
        const username = msg.from?.username || "";
        const text = (msg.text || "").trim();

        // ذخیره پیام‌ها در D1
        if (env.DB) {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS bale_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id TEXT,
              chat_id TEXT,
              first_name TEXT,
              username TEXT,
              message_text TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
          `).run();

          await env.DB.prepare(`
            INSERT INTO bale_messages
            (user_id, chat_id, first_name, username, message_text)
            VALUES (?, ?, ?, ?, ?)
          `)
            .bind(
              String(userId || ""),
              String(chatId || ""),
              firstName,
              username,
              text
            )
            .run();
        }

        if (!chatId) {
          return new Response("OK");
        }

        let reply = "";

        if (
          text === "/start" ||
          text === "شروع" ||
          text === "شروع رکورد مهر"
        ) {
          reply =
            "✅ ربات «رکورد غیربرقی مهر» فعال است.\n\n" +
            "پیام شما دریافت شد.";
        } else if (text === "وضعیت من") {
          reply =
            "✅ ارتباط شما با ربات برقرار است.\n" +
            "اطلاعات عملکرد و تارگت در مرحله بعد به این بخش متصل می‌شود.";
        } else {
          // فعلاً برای پیام‌های عادی پاسخ اضافه نمی‌فرستیم
          return new Response("OK");
        }

        await fetch(
          `https://tapi.bale.ai/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: reply,
            }),
          }
        );

        return new Response("OK");
      } catch (error) {
        return new Response("ERROR: " + error.message, {
          status: 500,
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
