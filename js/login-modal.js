(function () {
  function initLoginModal() {
    const modalHtml = `
      <div class="modal-overlay" id="login-modal">
        <div class="modal login-modal">
          <div class="modal-title" id="login-title">登录 / 注册</div>
          <input type="email" class="form-input" id="login-email" placeholder="邮箱">
          <div class="login-code-row" id="login-code-row">
            <input type="text" class="form-input" id="login-code" placeholder="请输入 6 位邮箱验证码" maxlength="6" inputmode="numeric" autocomplete="one-time-code">
            <button class="btn btn-secondary" id="login-send-code">发送验证码</button>
          </div>
          <div id="login-error" class="login-error"></div>
          <div class="action-row" style="margin:0;">
            <button class="btn btn-secondary" id="login-cancel">取消</button>
            <button class="btn btn-primary" id="login-submit">验证并登录</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = document.getElementById('login-modal');
    const emailInput = document.getElementById('login-email');
    const codeInput = document.getElementById('login-code');
    const sendCodeBtn = document.getElementById('login-send-code');
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-submit');
    const cancelBtn = document.getElementById('login-cancel');

    let countdownTimer = null;

    function showError(msg) {
      errorEl.textContent = msg;
    }

    function showToast(message) {
      let toast = document.getElementById('login-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'login-toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
      }
      toast.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 2000);
    }

    window.showLoginModal = function () {
      emailInput.value = '';
      codeInput.value = '';
      showError('');
      modal.classList.add('active');
      emailInput.focus();
    };

    window.hideLoginModal = function () {
      modal.classList.remove('active');
    };

    window.requireAuth = function (callback) {
      if (window.currentUser) {
        callback();
      } else {
        window.authCallback = callback;
        window.showLoginModal();
      }
    };

    function startCountdown() {
      let seconds = 60;
      sendCodeBtn.disabled = true;
      sendCodeBtn.textContent = `${seconds}s 后重发`;

      countdownTimer = setInterval(() => {
        seconds--;
        if (seconds <= 0) {
          clearInterval(countdownTimer);
          sendCodeBtn.disabled = false;
          sendCodeBtn.textContent = '发送验证码';
        } else {
          sendCodeBtn.textContent = `${seconds}s 后重发`;
        }
      }, 1000);
    }

    async function sendCode() {
      const email = emailInput.value.trim();
      if (!email) {
        showError('请先输入邮箱');
        return;
      }

      sendCodeBtn.disabled = true;
      sendCodeBtn.classList.add('btn-loading');
      try {
        const { error } = await supabaseClient.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: true }
        });
        if (error) throw error;
        startCountdown();
        showError('验证码已发送，请查收邮箱');
      } catch (err) {
        showError(err.message || '发送验证码失败');
        sendCodeBtn.disabled = false;
      } finally {
        sendCodeBtn.classList.remove('btn-loading');
      }
    }

    async function handleSubmit() {
      const email = emailInput.value.trim();
      const code = codeInput.value.trim();

      if (!email) {
        showError('请输入邮箱');
        return;
      }
      if (!/^\d{6}$/.test(code)) {
        showError('请输入 6 位数字验证码');
        return;
      }

      submitBtn.disabled = true;
      const originalText = submitBtn.textContent;
      submitBtn.textContent = '处理中...';

      try {
        let { error } = await supabaseClient.auth.verifyOtp({
          email,
          token: code,
          type: 'email'
        });

        if (error) {
          const { error: signUpError } = await supabaseClient.auth.verifyOtp({
            email,
            token: code,
            type: 'signup'
          });
          if (signUpError) throw signUpError;
        }

        hideLoginModal();
        sessionStorage.setItem('loginSuccess', '1');

        setTimeout(() => {
          location.href = 'index.html';
        }, 300);
      } catch (err) {
        showError(err.message || '验证失败，请重试');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    }

    submitBtn.addEventListener('click', handleSubmit);
    cancelBtn.addEventListener('click', hideLoginModal);
    sendCodeBtn.addEventListener('click', sendCode);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideLoginModal();
    });

    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });

    function syncHeaderAvatar(user) {
      const avatarLink = document.getElementById('header-avatar');
      const avatarIcon = document.getElementById('header-avatar-icon');
      const avatarImg = document.getElementById('header-avatar-img');
      if (!avatarLink || !avatarIcon || !avatarImg) return;

      const avatarUrl = user?.user_metadata?.avatar;
      if (avatarUrl) {
        avatarImg.src = avatarUrl;
        avatarImg.classList.remove('hidden');
        avatarIcon.classList.add('hidden');
        avatarLink.classList.add('with-img');
      } else {
        avatarImg.src = '';
        avatarImg.classList.add('hidden');
        avatarIcon.classList.remove('hidden');
        avatarLink.classList.remove('with-img');
      }
    }

    if (window.supabaseClient) {
      window.supabaseClient.auth.onAuthStateChange((event, session) => {
        window.currentUser = session?.user || null;
        syncHeaderAvatar(window.currentUser);
        document.body.dispatchEvent(new CustomEvent('authStateChanged', { detail: window.currentUser }));
      });

      window.supabaseClient.auth.getUser().then(({ data }) => {
        window.currentUser = data.user || null;
        syncHeaderAvatar(window.currentUser);
        document.body.dispatchEvent(new CustomEvent('authStateChanged', { detail: window.currentUser }));
      });
    }

    if (sessionStorage.getItem('loginSuccess') === '1') {
      sessionStorage.removeItem('loginSuccess');
      showToast('登录成功');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoginModal);
  } else {
    initLoginModal();
  }
})();
