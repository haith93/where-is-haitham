/**
 * Arabic / English interface.
 *
 * HOW IT WORKS
 * ------------
 *  * Markup carries `data-i18n` (text), `data-i18n-ph` (placeholder) and
 *    `data-i18n-aria` (aria-label). `apply()` walks the DOM and fills them in.
 *  * Anything rendered from JavaScript calls `t('key')`.
 *  * Switching language sets `lang` and `dir` on <html>, re-applies the
 *    markup, and tells the page to re-render — nothing navigates, so the
 *    current screen and scroll position survive.
 *
 * The stylesheets use logical properties (margin-inline-start and friends)
 * so the layout genuinely mirrors in Arabic rather than just changing words.
 */
/* No imports on purpose. config.js and utils.js both import this module,
   so it must sit at the bottom of the dependency graph. */

const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`wih.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`wih.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  }
};

export const LANGS = {
  en: { label: 'English',  dir: 'ltr', locale: 'en-GB' },
  ar: { label: 'العربية', dir: 'rtl', locale: 'ar-LB' }
};

const STRINGS = {
  /* ================= shared ================= */
  'app.name':            { en: 'Where Is Haitham Now?', ar: 'أين هيثم الآن؟' },
  'app.admin':           { en: 'Admin console',         ar: 'لوحة التحكم' },
  'app.staffSignIn':     { en: 'Staff sign-in',         ar: 'دخول الموظفين' },

  'action.cancel':       { en: 'Cancel',      ar: 'إلغاء' },
  'action.confirm':      { en: 'Confirm',     ar: 'تأكيد' },
  'action.save':         { en: 'Save',        ar: 'حفظ' },
  'action.close':        { en: 'Close',       ar: 'إغلاق' },
  'action.retry':        { en: 'Try again',   ar: 'حاول مرة أخرى' },
  'action.reload':       { en: 'Reload',      ar: 'إعادة التحميل' },
  'action.done':         { en: 'Done',        ar: 'تم' },
  'action.add':          { en: 'Add',         ar: 'إضافة' },
  'action.edit':         { en: 'Edit',        ar: 'تعديل' },
  'action.enable':       { en: 'Enable',      ar: 'تفعيل' },
  'action.disable':      { en: 'Disable',     ar: 'تعطيل' },
  'action.seeAll':       { en: 'See all',     ar: 'عرض الكل' },
  'action.more':         { en: 'More…',       ar: 'المزيد…' },
  'action.working':      { en: 'Working…',    ar: 'جارٍ التنفيذ…' },
  'action.sending':      { en: 'Sending…',    ar: 'جارٍ الإرسال…' },
  'action.saving':       { en: 'Saving…',     ar: 'جارٍ الحفظ…' },
  'action.newRequest':   { en: 'New request', ar: 'طلب جديد' },

  'common.theme':        { en: 'Switch theme',    ar: 'تغيير المظهر' },
  'common.language':     { en: 'Language',        ar: 'اللغة' },
  'common.time':         { en: 'Current time',    ar: 'الوقت الحالي' },
  'common.notifications':{ en: 'Notifications',   ar: 'الإشعارات' },
  'common.markAllRead':  { en: 'Mark all read',   ar: 'تعليم الكل كمقروء' },
  'common.none':         { en: 'None',            ar: 'لا شيء' },
  'common.optional':     { en: 'optional',        ar: 'اختياري' },
  'common.offline':      { en: 'You are offline. Changes cannot be saved until you reconnect.',
                           ar: 'أنت غير متصل بالإنترنت. لا يمكن حفظ التغييرات حتى تعود الاتصال.' },
  'common.backToBoard':  { en: '← Back to the status board', ar: '→ العودة إلى لوحة الحالة' },
  'common.new':          { en: 'New',             ar: 'جديد' },
  'common.checking':     { en: 'Checking…',       ar: 'جارٍ التحقق…' },

  /* ================= status types ================= */
  'status.available':      { en: 'Available',            ar: 'متفرّغ' },
  'status.busy':           { en: 'Busy',                 ar: 'مشغول' },
  'status.serving':        { en: 'With someone',         ar: 'مع أحد الزملاء' },
  'status.servingWith':    { en: 'With {name}',          ar: 'مع {name}' },
  'status.traveling':      { en: 'On the way',           ar: 'في الطريق' },
  'status.break':          { en: 'On break',             ar: 'في استراحة' },
  'status.meeting':        { en: 'In a meeting',         ar: 'في اجتماع' },
  'status.offsite':        { en: 'Off site',             ar: 'خارج المدرسة' },
  'status.done':           { en: 'Finished for the day', ar: 'انتهى الدوام' },

  'status.available.hint': { en: 'Free to help',                 ar: 'جاهز للمساعدة' },
  'status.busy.hint':      { en: 'Working on a task',            ar: 'يعمل على مهمة' },
  'status.serving.hint':   { en: 'Currently helping a colleague', ar: 'يساعد أحد الزملاء حالياً' },
  'status.traveling.hint': { en: 'Walking to another building',  ar: 'ينتقل إلى مبنى آخر' },
  'status.break.hint':     { en: 'Back shortly',                 ar: 'يعود بعد قليل' },
  'status.meeting.hint':   { en: 'In a meeting',                 ar: 'في اجتماع' },
  'status.offsite.hint':   { en: 'Away from the campus',         ar: 'خارج الحرم المدرسي' },
  'status.done.hint':      { en: 'Back tomorrow',                ar: 'يعود غداً' },

  /* ================= priority ================= */
  'priority.normal':      { en: 'Normal',      ar: 'عادي' },
  'priority.urgent':      { en: 'Urgent',      ar: 'عاجل' },
  'priority.very_urgent': { en: 'Very urgent', ar: 'عاجل جداً' },
  'priority.life_death':  { en: 'Life & death', ar: 'حياة أو موت' },

  /* ================= request status ================= */
  'reqstatus.pending':     { en: 'Received',    ar: 'تم الاستلام' },
  'reqstatus.accepted':    { en: 'Accepted',    ar: 'تم القبول' },
  'reqstatus.in_progress': { en: 'In progress', ar: 'قيد التنفيذ' },
  'reqstatus.paused':      { en: 'On hold',     ar: 'موقوف مؤقتاً' },
  'reqstatus.completed':   { en: 'Done',        ar: 'منجز' },
  'reqstatus.rejected':    { en: 'Rejected',    ar: 'مرفوض' },
  'reqstatus.cancelled':   { en: 'Cancelled',   ar: 'ملغى' },

  /* ================= channel ================= */
  'channel.app':       { en: 'App',        ar: 'التطبيق' },
  'channel.whatsapp':  { en: 'WhatsApp',   ar: 'واتساب' },
  'channel.phone':     { en: 'Phone',      ar: 'هاتف' },
  'channel.in_person': { en: 'In person',  ar: 'شخصياً' },
  'channel.other':     { en: 'Other',      ar: 'أخرى' },
  'channel.label':     { en: 'How did it arrive?', ar: 'كيف وصل الطلب؟' },

  /* ================= the board ================= */
  'board.heading':        { en: 'Where is Haitham now?', ar: 'أين هيثم الآن؟' },
  'board.noStatus':       { en: 'No status posted yet',  ar: 'لم يتم نشر أي حالة بعد' },
  'board.noStatusHint':   { en: 'Haitham has not posted a status yet.', ar: 'لم ينشر هيثم حالته بعد.' },
  'board.location':       { en: 'Location',   ar: 'المكان' },
  'board.doing':          { en: 'Doing',      ar: 'المهمة' },
  'board.started':        { en: 'Started',    ar: 'بدأ' },
  'board.expectedUntil':  { en: 'Expected until', ar: 'متوقع حتى' },
  'board.availability':   { en: 'Expected availability', ar: 'التفرّغ المتوقع' },
  'board.openEnded':      { en: 'Open ended', ar: 'غير محدد' },
  'board.now':            { en: 'Now',        ar: 'الآن' },
  'board.notStated':      { en: 'Not stated', ar: 'غير محدد' },
  'board.lastUpdated':    { en: 'Last updated', ar: 'آخر تحديث' },
  'board.here':           { en: 'Here',       ar: 'هنا منذ' },
  'board.serving':        { en: 'Currently serving', ar: 'يخدم حالياً' },
  'board.nextUp':         { en: 'Nobody is being served right now. Next:', ar: 'لا أحد يُخدم حالياً. التالي:' },
  'board.waiting':        { en: 'Waiting for Haitham', ar: 'في انتظار هيثم' },
  'board.nobodyWaiting':  { en: 'Nobody is waiting',   ar: 'لا أحد ينتظر' },
  'board.nobodyWaitingHint': { en: 'Haitham has no queue at the moment.', ar: 'لا يوجد طابور انتظار حالياً.' },
  'board.countWaiting':   { en: '{n} waiting',         ar: '{n} بالانتظار' },
  'board.expiredTitle':   { en: 'Expected time has passed.', ar: 'انتهى الوقت المتوقع.' },
  'board.expiredBody':    { en: 'This status may be out of date.', ar: 'قد تكون هذه الحالة قديمة.' },
  'board.staleTitle':     { en: 'This status is a few hours old.', ar: 'مضى على هذه الحالة بضع ساعات.' },
  'board.footer':         { en: 'This board replaces the phone call. Haitham updates it himself — there is no location tracking.',
                            ar: 'هذه اللوحة تغنيك عن الاتصال. هيثم يحدّثها بنفسه — لا يوجد أي تتبّع للموقع.' },
  'board.requestBtn':     { en: 'Request Haitham', ar: 'اطلب هيثم' },

  'counters.waiting':     { en: 'Waiting',     ar: 'بالانتظار' },
  'counters.urgent':      { en: 'Urgent',      ar: 'عاجل' },
  'counters.veryUrgent':  { en: 'Very urgent', ar: 'عاجل جداً' },
  'counters.pending':     { en: 'Pending',     ar: 'بالانتظار' },
  'counters.paused':      { en: 'On hold',     ar: 'معلّق' },

  /* ================= the request form ================= */
  /* ---- Print requests ---------------------------------------------- */
  'print.tabHelp':      { en: 'Ask for help',    ar: 'اطلب مساعدة' },
  'print.tabPrint':     { en: 'Print something', ar: 'اطبع مستنداً' },
  'print.intro':        { en: 'Attach the document and say how to print it. Only Haitham can open the file.',
                          ar: 'أرفق المستند وحدّد طريقة الطباعة. هيثم وحده يستطيع فتح الملف.' },

  'print.docHeading':   { en: 'The document',    ar: 'المستند' },
  'print.titleLabel':   { en: 'Title (optional)', ar: 'العنوان (اختياري)' },
  'print.titlePh':      { en: 'e.g. Science worksheet', ar: 'مثال: ورقة عمل علوم' },
  'print.titleHelp':    { en: 'Colleagues see this title. They never see the file.',
                          ar: 'يرى الزملاء هذا العنوان فقط، ولا يرون الملف أبداً.' },
  'print.fileLabel':    { en: 'Document',        ar: 'الملف' },
  'print.choose':       { en: 'Choose a file',   ar: 'اختر ملفاً' },
  'print.change':       { en: 'Change file',     ar: 'غيّر الملف' },
  'print.fileHelp':     { en: 'PDF, Word, Excel, PowerPoint or an image. Up to {max}.',
                          ar: 'PDF أو Word أو Excel أو PowerPoint أو صورة. حتى {max}.' },
  'print.uploading':    { en: 'Uploading… {n}%', ar: 'جارٍ الرفع… {n}%' },
  'print.uploaded':     { en: 'Ready to send',   ar: 'جاهز للإرسال' },

  'print.optionsHeading': { en: 'How to print it', ar: 'طريقة الطباعة' },
  'print.paper':        { en: 'Paper size',      ar: 'حجم الورق' },
  'print.colourLabel':  { en: 'Colour',          ar: 'اللون' },
  'print.bw':           { en: 'Black & white',   ar: 'أبيض وأسود' },
  'print.colour':       { en: 'Colour',          ar: 'ملوّن' },
  'print.permissionQ':  { en: 'Do you have permission to print this in colour?',
                          ar: 'هل لديك إذن بطباعة هذا المستند بالألوان؟' },
  'print.yes':          { en: 'Yes',             ar: 'نعم' },
  'print.no':           { en: 'No',              ar: 'لا' },
  'print.permissionNo': { en: 'Colour needs permission first. Choose black & white, or go and ask.',
                          ar: 'الطباعة الملوّنة تحتاج إذناً. اختر أبيض وأسود أو اطلب الإذن.' },
  'print.sides':        { en: 'Sides',           ar: 'الوجوه' },
  'print.single':       { en: '1-sided',         ar: 'وجه واحد' },
  'print.double':       { en: 'Double-sided',    ar: 'وجهان' },
  'print.copies':       { en: 'Copies',          ar: 'عدد النسخ' },
  'print.copiesN':      { en: '{n} copies',      ar: '{n} نسخة' },

  'print.destHeading':  { en: 'Who is it for?',  ar: 'لمن هذه الطباعة؟' },
  'print.destHelp':     { en: 'Optional. Leave this empty if it is not for a class.',
                          ar: 'اختياري. اتركه فارغاً إن لم تكن لصف معيّن.' },
  'print.section':      { en: 'School section',  ar: 'القسم' },
  'print.level':        { en: 'Cycle',           ar: 'الحلقة' },
  'print.grade':        { en: 'Grade',           ar: 'الصف' },
  'print.anySection':   { en: 'Not for a class', ar: 'ليست لصف' },
  'print.chooseLevel':  { en: 'Choose a cycle',  ar: 'اختر الحلقة' },
  'print.chooseGrade':  { en: 'Choose a grade',  ar: 'اختر الصف' },

  'print.note':         { en: 'Note (optional)', ar: 'ملاحظة (اختياري)' },
  'print.notePh':       { en: 'e.g. Staple these together', ar: 'مثال: دبّسها معاً' },
  'print.submit':       { en: 'Send print request', ar: 'أرسل طلب الطباعة' },

  'print.publicPlain':  { en: 'Printing something for {name}',
                          ar: 'يطبع شيئاً لـ{name}' },
  'print.publicTitled': { en: 'Printing "{title}" for {name}',
                          ar: 'يطبع «{title}» لـ{name}' },
  'print.aPrintJob':    { en: 'Print job',       ar: 'طلب طباعة' },
  'print.filename':     { en: 'File',            ar: 'الملف' },
  'print.openDoc':      { en: 'Open document',   ar: 'افتح المستند' },
  'print.opening':      { en: 'Opening…',        ar: 'جارٍ الفتح…' },
  'print.destination':  { en: 'For',             ar: 'إلى' },
  'print.privateNote':  { en: 'Only Haitham can open this file.',
                          ar: 'هيثم وحده يستطيع فتح هذا الملف.' },

  'print.errNoFile':    { en: 'Please choose the document to print.', ar: 'اختر المستند المطلوب طباعته.' },
  'print.errEmpty':     { en: 'That file is empty.', ar: 'هذا الملف فارغ.' },
  'print.errTooBig':    { en: 'That file is larger than {max}.', ar: 'حجم الملف أكبر من {max}.' },
  'print.errType':      { en: 'That kind of file cannot be printed. Send a PDF, Word, Excel, PowerPoint or image.',
                          ar: 'لا يمكن طباعة هذا النوع. أرسل PDF أو Word أو Excel أو PowerPoint أو صورة.' },
  'print.errUpload':    { en: 'The document could not be uploaded. Please try again.',
                          ar: 'تعذّر رفع المستند. حاول مرة أخرى.' },
  'print.errSubmit':    { en: 'Your print request could not be sent. Please try again.',
                          ar: 'تعذّر إرسال طلب الطباعة. حاول مرة أخرى.' },
  'print.errLoad':      { en: 'The document could not be opened.', ar: 'تعذّر فتح المستند.' },
  'print.errName':      { en: 'Please enter your name.', ar: 'اكتب اسمك.' },
  'print.errNameLong':  { en: 'That name is too long.', ar: 'الاسم طويل جداً.' },
  'print.errWhere':     { en: 'Please choose where you are.', ar: 'اختر مكانك.' },
  'print.errCopies':    { en: 'Copies must be a whole number between 1 and {max}.',
                          ar: 'عدد النسخ يجب أن يكون رقماً بين ١ و{max}.' },
  'print.errPermission': { en: 'Colour printing needs permission first.', ar: 'الطباعة الملوّنة تحتاج إذناً أولاً.' },
  'print.errNote':      { en: 'The note is limited to {max} characters.', ar: 'الملاحظة محدودة بـ{max} حرفاً.' },
  'print.errTitle':     { en: 'Please shorten the title.', ar: 'اختصر العنوان.' },

  'form.requiredKey':   { en: '* required',     ar: '* حقل مطلوب' },
  'form.title':         { en: 'Request Haitham',  ar: 'اطلب هيثم' },
  'form.intro':         { en: 'No account needed. Fill this in and Haitham sees it immediately.',
                          ar: 'لا حاجة لحساب. املأ النموذج وسيصل الطلب إلى هيثم فوراً.' },
  'form.yourName':      { en: 'Your name',       ar: 'اسمك' },
  'form.namePlaceholder': { en: 'Type your real name', ar: 'اكتب اسمك الحقيقي' },
  'form.nameHelp':      { en: 'So Haitham knows who to come to.', ar: 'ليعرف هيثم إلى من يأتي.' },
  'form.where':         { en: 'Where are you?',  ar: 'أين أنت؟' },
  'form.selectLocation':{ en: 'Select where you are', ar: 'اختر مكانك' },
  'form.customLocation':{ en: '+ Other / custom location', ar: '+ مكان آخر' },
  'form.typeLocation':  { en: 'Type the location', ar: 'اكتب المكان' },
  'form.locationPlaceholder': { en: 'e.g. Science Laboratory', ar: 'مثال: مختبر العلوم' },
  'form.need':          { en: 'What do you need?', ar: 'ما الذي تحتاجه؟' },
  'form.selectNeed':    { en: 'Select what you need', ar: 'اختر ما تحتاجه' },
  'form.customNeed':    { en: '+ Other / custom',  ar: '+ شيء آخر' },
  'form.typeNeed':      { en: 'Type what you need', ar: 'اكتب ما تحتاجه' },
  'form.needPlaceholder': { en: 'e.g. Scanner not working', ar: 'مثال: الماسح الضوئي لا يعمل' },
  'form.description':   { en: 'Description',      ar: 'التفاصيل' },
  'form.descPlaceholder': { en: 'Printer in room 204 is not printing.', ar: 'الطابعة في الغرفة ٢٠٤ لا تطبع.' },
  'form.descHelp':      { en: 'Room numbers and machine names help a lot.', ar: 'ذكر رقم الغرفة واسم الجهاز يساعد كثيراً.' },
  'form.priority':      { en: 'How urgent?',      ar: 'ما مدى الاستعجال؟' },
  'form.priorityHelp':  { en: 'Keep "Very urgent" for things that stop work right now, and "Life & death" for a real emergency.',
                          ar: 'احتفظ بـ"عاجل جداً" لما يوقف العمل فوراً، و"حياة أو موت" للطوارئ الحقيقية.' },
  'form.submit':        { en: 'Send request',     ar: 'إرسال الطلب' },
  'form.successTitle':  { en: 'Request sent',     ar: 'تم إرسال الطلب' },
  'form.successBody':   { en: 'Haitham has been notified. Your reference is', ar: 'تم إبلاغ هيثم. رقم طلبك هو' },
  'form.peopleAhead':   { en: '{n} ahead of you.', ar: '{n} قبلك في الانتظار.' },
  'form.youAreNext':    { en: 'You are next in the queue.', ar: 'أنت التالي في الانتظار.' },

  /* ================= following your own request ================= */
  'mine.title':       { en: 'My requests',   ar: 'طلباتي' },
  'mine.subtitle':    { en: 'Requests you sent from this device.', ar: 'الطلبات التي أرسلتها من هذا الجهاز.' },
  'mine.empty':       { en: 'Nothing sent yet', ar: 'لم ترسل أي طلب بعد' },
  'mine.emptyHint':   { en: 'Tap "Request Haitham" when you need help.', ar: 'اضغط "اطلب هيثم" عندما تحتاج مساعدة.' },
  'mine.cancel':      { en: 'Cancel this request', ar: 'إلغاء هذا الطلب' },
  'mine.cancelConfirm': { en: 'Cancel this request? Haitham will see that you no longer need help.',
                          ar: 'هل تريد إلغاء هذا الطلب؟ سيرى هيثم أنك لم تعد بحاجة إلى المساعدة.' },
  'mine.cancelled':   { en: 'Request cancelled.', ar: 'تم إلغاء الطلب.' },
  'mine.sent':        { en: 'Sent',           ar: 'أُرسل' },
  'mine.ahead':       { en: '{n} ahead of you', ar: '{n} قبلك' },
  'mine.forget':      { en: 'Clear from this device', ar: 'مسح من هذا الجهاز' },
  'mine.edit':        { en: 'Change this request', ar: 'تعديل هذا الطلب' },
  'mine.editTitle':   { en: 'Change your request', ar: 'تعديل طلبك' },
  'mine.editHint':    { en: 'You can add detail or change how urgent it is while Haitham has not started yet.',
                        ar: 'يمكنك إضافة تفاصيل أو تغيير درجة الاستعجال ما دام هيثم لم يبدأ بعد.' },
  'mine.editSave':    { en: 'Save changes', ar: 'حفظ التعديلات' },
  'mine.edited':      { en: 'Your request was updated.', ar: 'تم تحديث طلبك.' },
  'mine.editClosed':  { en: 'Haitham has already started this one, so it can no longer be changed.',
                        ar: 'بدأ هيثم العمل على هذا الطلب، لذا لم يعد من الممكن تعديله.' },

  /* ================= admin: navigation ================= */
  'admin.dashboard': { en: 'Dashboard', ar: 'الرئيسية' },
  'admin.myStatus':  { en: 'My status', ar: 'حالتي' },
  'admin.requests':  { en: 'Requests',  ar: 'الطلبات' },
  'admin.buildings': { en: 'Buildings', ar: 'المباني' },
  'admin.tasks':     { en: 'Tasks',     ar: 'المهام' },
  'admin.users':     { en: 'Users',     ar: 'المستخدمون' },
  'admin.reports':   { en: 'Reports',   ar: 'التقارير' },
  'admin.history':   { en: 'History',   ar: 'السجل' },
  'admin.settings':  { en: 'Settings',  ar: 'الإعدادات' },
  'admin.viewBoard': { en: 'View public board', ar: 'عرض اللوحة العامة' },
  'admin.home':      { en: 'Home',      ar: 'الرئيسية' },
  'admin.queue':     { en: 'Queue',     ar: 'الطابور' },
  'admin.status':    { en: 'Status',    ar: 'الحالة' },
  'admin.moreNav':   { en: 'More',      ar: 'المزيد' },

  /* ================= admin: dashboard ================= */
  'admin.greetingNone': { en: 'Post your first status so everyone can stop calling.',
                          ar: 'انشر حالتك الأولى ليتوقف الجميع عن الاتصال.' },
  'admin.greetingSet':  { en: 'You are marked as "{status}".', ar: 'حالتك الحالية: "{status}".' },
  'admin.updateStatus': { en: 'Update location / task', ar: 'تحديث المكان / المهمة' },
  'admin.availableNow': { en: "I'm available now",      ar: 'أنا متفرّغ الآن' },
  'admin.finishTask':   { en: 'Finish current task',    ar: 'إنهاء المهمة الحالية' },
  'admin.viewRequests': { en: 'View requests',          ar: 'عرض الطلبات' },
  'admin.nextInQueue':  { en: 'Next in the queue',      ar: 'التالي في الطابور' },
  'admin.todaySoFar':   { en: 'Today so far',           ar: 'اليوم حتى الآن' },
  'admin.workingTime':  { en: 'Working time',           ar: 'وقت العمل' },
  'admin.activities':   { en: 'Activities',             ar: 'الأنشطة' },
  'admin.requestsDone': { en: 'Requests done',          ar: 'طلبات منجزة' },
  'admin.received':     { en: '{n} received',           ar: '{n} وارد' },
  'admin.noStatusYet':  { en: 'No status posted yet',   ar: 'لم تنشر أي حالة بعد' },
  'admin.expiredNudge': { en: 'Expected end passed {ago} ago. Post an update so everyone sees where you really are.',
                          ar: 'مضى {ago} على الوقت المتوقع للانتهاء. حدّث حالتك ليعرف الجميع أين أنت فعلاً.' },
  'admin.updatedAgo':   { en: 'Updated {ago}',          ar: 'آخر تحديث {ago}' },

  /* ================= admin: my status ================= */
  'admin.statusTitle':  { en: 'Update my status', ar: 'تحديث حالتي' },
  'admin.statusIntro':  { en: 'Pick where, what and for how long. The times are worked out for you.',
                          ar: 'اختر المكان والمهمة والمدة. يتم حساب الأوقات تلقائياً.' },
  'admin.statusLabel':  { en: 'Status',   ar: 'الحالة' },
  'admin.location':     { en: 'Location', ar: 'المكان' },
  'admin.task':         { en: 'Task',     ar: 'المهمة' },
  'admin.noLocation':   { en: 'No specific location', ar: 'بدون مكان محدد' },
  'admin.noTask':       { en: 'No specific task',     ar: 'بدون مهمة محددة' },
  'admin.customLocation': { en: '+ Other / custom location', ar: '+ مكان مخصص' },
  'admin.customTask':   { en: '+ Other / custom task',       ar: '+ مهمة مخصصة' },
  'admin.customOnce':   { en: 'Used for this update only. It is not added to the permanent list.',
                          ar: 'يُستخدم لهذا التحديث فقط ولا يُضاف إلى القائمة الدائمة.' },
  'admin.howLong':      { en: 'How long?', ar: 'كم من الوقت؟' },
  'admin.howLongOpt':   { en: 'How long? (optional)', ar: 'كم من الوقت؟ (اختياري)' },
  'admin.customDuration': { en: 'Custom…',      ar: 'مدة مخصصة…' },
  'admin.noFixedTime':  { en: 'No fixed time',  ar: 'بدون وقت محدد' },
  'admin.minutes':      { en: 'Minutes',        ar: 'دقائق' },
  'admin.willBe':       { en: 'This status will be', ar: 'ستكون الحالة' },
  'admin.autoTime':     { en: 'Current time is used automatically.', ar: 'يُستخدم الوقت الحالي تلقائياً.' },
  'admin.runsFor':      { en: 'Starts now and runs for {duration}. You never type a time.',
                          ar: 'تبدأ الآن وتستمر {duration}. لا تحتاج لكتابة أي وقت.' },
  'admin.openEndedSub': { en: 'Starts now, with no expected finish time.', ar: 'تبدأ الآن بدون وقت انتهاء متوقع.' },
  'admin.submitStatus': { en: 'Update status',  ar: 'تحديث الحالة' },
  'admin.shortcuts':    { en: 'Shortcuts',      ar: 'اختصارات' },
  'admin.shortcutsHint':{ en: 'Your most-used combinations will appear here after a few updates.',
                          ar: 'ستظهر هنا أكثر التركيبات استخداماً بعد عدة تحديثات.' },
  'admin.shortcutFilled': { en: 'Filled in. Check it, then tap "Update status".',
                            ar: 'تم الملء. راجعها ثم اضغط "تحديث الحالة".' },
  'admin.statusUpdated':{ en: 'Status updated. Everyone can see it now.', ar: 'تم تحديث الحالة. يراها الجميع الآن.' },

  /* ================= admin: queue ================= */
  'admin.queueTitle':   { en: 'Service queue', ar: 'طابور الخدمة' },
  'admin.queueEmpty':   { en: 'The queue is empty', ar: 'الطابور فارغ' },
  'admin.queueEmptyHint': { en: 'Enjoy the quiet.', ar: 'استمتع بالهدوء.' },
  'admin.nobodyWaitingNow': { en: 'Nobody is waiting right now.', ar: 'لا أحد ينتظر حالياً.' },
  'admin.waitingSummary': { en: '{n} waiting', ar: '{n} بالانتظار' },
  'admin.urgentSuffix': { en: ', {n} marked urgent', ar: '، {n} عاجل' },
  'admin.workingNow':   { en: 'Working on now', ar: 'قيد العمل الآن' },
  'admin.waitingGroup': { en: 'Waiting',        ar: 'بالانتظار' },
  'admin.requestsGroup':{ en: 'Requests',       ar: 'الطلبات' },
  'admin.accept':       { en: 'Accept',         ar: 'قبول' },
  'admin.reject':       { en: 'Reject',         ar: 'رفض' },
  'admin.startNow':     { en: 'Start now',      ar: 'ابدأ الآن' },
  'admin.complete':     { en: 'Complete',       ar: 'إنهاء' },
  'admin.pause':        { en: 'Put on hold',     ar: 'تعليق مؤقت' },
  'admin.resume':       { en: 'Pick it back up', ar: 'استئناف' },
  'admin.pausedGroup':  { en: 'Put down, not finished', ar: 'مُعلَّق ولم يُنجز بعد' },
  'admin.pausedFor':    { en: 'On hold for {d}', ar: 'معلّق منذ {d}' },
  'admin.pauseWhy':     { en: 'Putting down the job for {name}. What happened?',
                          ar: 'تعليق العمل الخاص بـ {name}. ما السبب؟' },
  'admin.pauseUrgent':  { en: 'Something more urgent came up', ar: 'طرأ ما هو أكثر إلحاحاً' },
  'admin.pauseBlocked': { en: 'Waiting on a part or someone else', ar: 'بانتظار قطعة أو شخص آخر' },
  'admin.pauseOther':   { en: 'Other reason', ar: 'سبب آخر' },
  'admin.pausedToast':  { en: 'Put on hold. It stays in your queue.',
                          ar: 'تم التعليق. يبقى في طابورك.' },
  'admin.resumedToast': { en: 'Picked back up. Your status has moved.',
                          ar: 'تم الاستئناف. تم نقل حالتك.' },
  'admin.sentAt':       { en: 'Sent {time}',    ar: 'أُرسل {time}' },
  'admin.filterOpen':   { en: 'Open',           ar: 'مفتوح' },
  'admin.filterToday':  { en: 'Today (all)',    ar: 'اليوم (الكل)' },
  'admin.filterClosed': { en: 'Recently closed', ar: 'أُغلق مؤخراً' },
  'admin.nothingToShow':{ en: 'Nothing to show', ar: 'لا شيء لعرضه' },
  'admin.tryAnotherFilter': { en: 'Try another filter.', ar: 'جرّب تصفية أخرى.' },
  'admin.changePriority': { en: 'Change priority', ar: 'تغيير الأولوية' },
  'admin.moveInQueue':  { en: 'Move in the queue', ar: 'تحريك في الطابور' },
  'admin.earlier':      { en: '↑ Earlier',      ar: '↑ أبكر' },
  'admin.later':        { en: '↓ Later',        ar: '↓ لاحقاً' },
  'admin.orderHint':    { en: 'The order is yours to choose — nothing is decided automatically.',
                          ar: 'الترتيب بيدك — لا شيء يُقرَّر تلقائياً.' },
  'admin.requestHistory': { en: 'History',      ar: 'السجل' },
  'admin.goingNow':     { en: 'Going there now',    ar: 'سأذهب الآن' },
  'admin.afterCurrent': { en: 'After my current task', ar: 'بعد مهمتي الحالية' },
  'admin.needsHelp':    { en: '{name} needs help in {place}.', ar: '{name} يحتاج المساعدة في {place}.' },
  'admin.acceptedNext': { en: 'Accepted. It stays in the queue as your next job.',
                          ar: 'تم القبول. يبقى في الطابور كمهمتك التالية.' },
  'admin.accepting':    { en: 'Accepting…', ar: 'جارٍ القبول…' },
  'admin.acceptQ':      { en: "Accept {name}'s request in {place}. Are you going there now?",
                          ar: 'قبول طلب {name} في {place}. هل ستذهب الآن؟' },
  'admin.acceptedTravel': { en: 'Accepted. You are shown as on the way.', ar: 'تم القبول. حالتك الآن "في الطريق".' },
  'admin.acceptedQueue':{ en: 'Accepted. It stays in the queue.', ar: 'تم القبول. يبقى الطلب في الطابور.' },
  'admin.startedToast': { en: 'Started. Your status now shows who you are with.',
                          ar: 'بدأ العمل. تُظهر حالتك الآن مع من أنت.' },
  'admin.completedToast': { en: 'Request completed.', ar: 'تم إنجاز الطلب.' },
  'admin.rejectConfirm':{ en: 'Reject this request? The person will be told it was not accepted.',
                          ar: 'رفض هذا الطلب؟ سيُبلَّغ صاحبه بعدم قبوله.' },

  /* ================= admin: record a request on behalf ================= */
  'behalf.button':      { en: '+ Record a request', ar: '+ تسجيل طلب' },
  'behalf.title':       { en: 'Record a request on behalf of someone', ar: 'تسجيل طلب نيابة عن شخص' },
  'behalf.intro':       { en: 'For calls, WhatsApp messages and people who stop you in the corridor. It becomes a normal request in the same queue, history and reports.',
                          ar: 'للاتصالات ورسائل واتساب ومن يوقفك في الممر. يصبح طلباً عادياً ضمن الطابور والسجل والتقارير نفسها.' },
  'behalf.who':         { en: 'Who asked?',      ar: 'من طلب؟' },
  'behalf.whoPlaceholder': { en: 'e.g. George Saab', ar: 'مثال: جورج صعب' },
  'behalf.what':        { en: 'What do they need?', ar: 'ماذا يحتاج؟' },
  'behalf.notes':       { en: 'Notes (optional)', ar: 'ملاحظات (اختياري)' },
  'behalf.notesPlaceholder': { en: 'Anything worth remembering.', ar: 'أي شيء يستحق التذكر.' },
  'behalf.startNow':    { en: 'I am handling this right now', ar: 'أنا أتولّى هذا الآن' },
  'behalf.startNowHint':{ en: 'Records it and starts the work in one step, moving your status to their location.',
                          ar: 'يسجّل الطلب ويبدأ العمل بخطوة واحدة، وينقل حالتك إلى مكانهم.' },
  'behalf.submit':      { en: 'Record request',  ar: 'تسجيل الطلب' },
  'behalf.saved':       { en: 'Request recorded as {number}.', ar: 'تم تسجيل الطلب برقم {number}.' },
  'behalf.savedStarted':{ en: 'Recorded and started. Your status has moved.', ar: 'تم التسجيل والبدء. تم نقل حالتك.' },

  /* ================= admin: config ================= */
  'admin.buildingsIntro': { en: 'Locations you can choose from. Disable instead of deleting so old reports keep their names.',
                            ar: 'الأماكن المتاحة للاختيار. عطّلها بدل حذفها لتحتفظ التقارير القديمة بأسمائها.' },
  'admin.tasksIntro':   { en: 'The kinds of work you do. Also used as the categories people pick from.',
                          ar: 'أنواع الأعمال التي تقوم بها. تُستخدم أيضاً كفئات يختار منها الزملاء.' },
  'admin.newBuilding':  { en: 'New building name', ar: 'اسم مبنى جديد' },
  'admin.newTask':      { en: 'New task name',     ar: 'اسم مهمة جديدة' },
  'admin.active':       { en: 'Active',            ar: 'مفعّل' },
  'admin.nameEn':       { en: 'Name (English)',    ar: 'الاسم (بالإنكليزية)' },
  'admin.nameAr':       { en: 'Name (Arabic)',     ar: 'الاسم (بالعربية)' },
  'admin.noArabicName': { en: 'No Arabic name yet — tap Edit to add one',
                          ar: 'لا يوجد اسم عربي — اضغط تعديل لإضافته' },
  'admin.renameEn':     { en: 'English name for this {noun}:', ar: 'الاسم الإنكليزي لهذا العنصر:' },
  'admin.renameAr':     { en: 'Arabic name (leave empty to use the English one):',
                          ar: 'الاسم العربي (اتركه فارغاً لاستخدام الإنكليزي):' },
  'admin.disabled':     { en: 'Disabled',          ar: 'معطّل' },
  'admin.position':     { en: 'position {n}',      ar: 'الترتيب {n}' },
  'admin.usersIntro':   { en: 'Administrator accounts. Employees do not need accounts at all.',
                          ar: 'حسابات المسؤولين. الزملاء لا يحتاجون حسابات إطلاقاً.' },
  'admin.searchUsers':  { en: 'Search by name or e-mail', ar: 'ابحث بالاسم أو البريد' },
  'admin.makeAdmin':    { en: 'Make admin',    ar: 'تعيين كمسؤول' },
  'admin.makeEmployee': { en: 'Make employee', ar: 'تعيين كموظف' },
  'admin.deactivate':   { en: 'Deactivate',    ar: 'تعطيل' },
  'admin.activate':     { en: 'Activate',      ar: 'تفعيل' },

  /* ================= admin: reports & history ================= */
  'admin.reportsTitle': { en: 'Reports', ar: 'التقارير' },
  'admin.today':        { en: 'Today',      ar: 'اليوم' },
  'admin.yesterday':    { en: 'Yesterday',  ar: 'أمس' },
  'admin.thisWeek':     { en: 'This week',  ar: 'هذا الأسبوع' },
  'admin.thisMonth':    { en: 'This month', ar: 'هذا الشهر' },
  'admin.customRange':  { en: 'Custom range', ar: 'فترة مخصصة' },
  'admin.from':         { en: 'From',   ar: 'من' },
  'admin.to':           { en: 'To',     ar: 'إلى' },
  'admin.apply':        { en: 'Apply',  ar: 'تطبيق' },
  'admin.moreFilters':  { en: 'More filters', ar: 'تصفية إضافية' },
  'admin.anyBuilding':  { en: 'Any building', ar: 'كل المباني' },
  'admin.anyTask':      { en: 'Any task',     ar: 'كل المهام' },
  'admin.anyPriority':  { en: 'Any priority', ar: 'كل الأولويات' },
  'admin.anyStatus':    { en: 'Any status',   ar: 'كل الحالات' },
  'admin.anyChannel':   { en: 'Any channel',  ar: 'كل القنوات' },
  'admin.clearFilters': { en: 'Clear filters', ar: 'إزالة التصفية' },
  'admin.export':       { en: 'Export',  ar: 'تصدير' },
  'admin.summaryCSV':   { en: 'Summary CSV',  ar: 'ملخص CSV' },
  'admin.requestsCSV':  { en: 'Requests CSV', ar: 'طلبات CSV' },
  'admin.activityCSV':  { en: 'Activity CSV', ar: 'نشاط CSV' },
  'admin.print':        { en: 'Print / save PDF', ar: 'طباعة / حفظ PDF' },
  'admin.requestsLabel':{ en: 'Requests',   ar: 'الطلبات' },
  'admin.completed':    { en: 'Completed',  ar: 'منجزة' },
  'admin.stillOpen':    { en: 'Still open', ar: 'ما زالت مفتوحة' },
  'admin.avgCompletion':{ en: 'Avg. completion', ar: 'متوسط الإنجاز' },
  'admin.perDay':       { en: '{n} per day',     ar: '{n} يومياً' },
  'admin.ofTotal':      { en: '{n}% of total',   ar: '{n}% من الإجمالي' },
  'admin.toAccept':     { en: '{d} to accept',   ar: '{d} حتى القبول' },
  'admin.tracked':      { en: '{d} tracked',     ar: '{d} مُسجّل' },
  'admin.noData':       { en: 'No data for this period.', ar: 'لا توجد بيانات لهذه الفترة.' },
  'admin.todayLower':   { en: 'today',           ar: 'اليوم' },
  'admin.pendingSub':   { en: '{n} pending',     ar: '{n} معلّق' },
  'admin.veryUrgentSub':{ en: '{n} very urgent', ar: '{n} عاجل جداً' },
  'admin.noDataShort':  { en: 'no data',         ar: 'لا بيانات' },
  'admin.noActivity':   { en: 'No activity recorded in this period.', ar: 'لا يوجد نشاط مسجّل في هذه الفترة.' },
  'admin.noRequests':   { en: 'No requests in this period.', ar: 'لا توجد طلبات في هذه الفترة.' },
  'admin.notEnough':    { en: 'Not enough finished activities with a chosen duration yet.',
                          ar: 'لا توجد أنشطة منتهية كافية ذات مدة محددة بعد.' },
  'admin.recordedNote': { en: 'Requests recorded by hand are the ones that arrived by phone, WhatsApp or in person.',
                          ar: 'الطلبات المسجَّلة يدوياً هي التي وصلت عبر الهاتف أو واتساب أو شخصياً.' },
  'admin.requestsPerDay': { en: 'Requests per day', ar: 'الطلبات يومياً' },
  'admin.timeByLocation': { en: 'Time by location', ar: 'الوقت حسب المكان' },
  'admin.timeByTask':   { en: 'Time by task',   ar: 'الوقت حسب المهمة' },
  'admin.tasksByCount': { en: 'Tasks by count', ar: 'المهام حسب العدد' },
  'admin.byCategory':   { en: 'Requests by category', ar: 'الطلبات حسب الفئة' },
  'admin.byBuilding':   { en: 'Requests by building', ar: 'الطلبات حسب المبنى' },
  'admin.byPriority':   { en: 'Requests by priority', ar: 'الطلبات حسب الأولوية' },
  'admin.byChannel':    { en: 'How requests arrived',  ar: 'كيف وصلت الطلبات' },
  'admin.expectedActual': { en: 'Expected vs actual', ar: 'المتوقع مقابل الفعلي' },
  'admin.avgPlanned':   { en: 'Avg. planned', ar: 'متوسط المخطط' },
  'admin.avgActual':    { en: 'Avg. actual',  ar: 'متوسط الفعلي' },
  'admin.ranOver':      { en: 'Ran over',     ar: 'تجاوزت الوقت' },
  'admin.ofFinished':   { en: 'of {n} finished', ar: 'من {n} منتهية' },
  'admin.expectedNote': { en: 'The duration you pick is only an expectation. Actual time comes from when you really changed status, which is why these two numbers differ.',
                          ar: 'المدة التي تختارها مجرد توقع. الوقت الفعلي يُحسب من لحظة تغييرك للحالة فعلياً، ولهذا يختلف الرقمان.' },
  'admin.highlights':   { en: 'Highlights', ar: 'أبرز النقاط' },
  'admin.mostCommonTask': { en: 'Most common task', ar: 'أكثر مهمة تكراراً' },
  'admin.mostTimeAt':   { en: 'Most time spent at', ar: 'أكثر مكان قضيت فيه وقتاً' },
  'admin.busiestDay':   { en: 'Busiest day', ar: 'أكثر يوم ازدحاماً' },
  'admin.historyIntro': { en: 'Everywhere you have been, with the real time spent.',
                          ar: 'كل الأماكن التي كنت فيها، مع الوقت الفعلي المستغرق.' },
  'admin.searchHistory':{ en: 'Search location or task', ar: 'ابحث في الأماكن أو المهام' },
  'admin.nothingRecorded': { en: 'Nothing recorded', ar: 'لا شيء مسجّل' },
  'admin.widerRange':   { en: 'Try a wider date range.', ar: 'جرّب فترة زمنية أوسع.' },
  'admin.stillOpenRow': { en: 'Still open', ar: 'ما زالت مفتوحة' },
  'admin.overPlan':     { en: '{d} over plan',  ar: '{d} فوق المخطط' },
  'admin.underPlan':    { en: '{d} under plan', ar: '{d} دون المخطط' },
  'admin.onPlan':       { en: 'on plan',        ar: 'ضمن المخطط' },
  'admin.planned':      { en: 'planned {d}',    ar: 'المخطط {d}' },
  'admin.working':      { en: '{d} working',    ar: '{d} عمل' },

  /* ================= admin: settings ================= */
  'admin.settingsIntro':{ en: "Application configuration and this device's notifications.",
                          ar: 'إعدادات التطبيق وإشعارات هذا الجهاز.' },
  'admin.naming':       { en: 'Naming', ar: 'التسمية' },

  /* ================= staff sign-in ================= */
  'staff.title':        { en: 'Administrator sign-in', ar: 'دخول المسؤول' },
  'staff.intro':        { en: 'For Haitham and anyone else with an e-mail account.',
                          ar: 'لهيثم ولكل من لديه حساب بالبريد الإلكتروني.' },
  'staff.employeesUse': { en: 'Colleagues sending a request do not need an account.',
                          ar: 'الزملاء الذين يرسلون طلباً لا يحتاجون إلى حساب.' },
  'staff.email':        { en: 'E-mail',   ar: 'البريد الإلكتروني' },
  'staff.password':     { en: 'Password', ar: 'كلمة المرور' },
  'staff.signIn':       { en: 'Sign in',  ar: 'تسجيل الدخول' },
  'staff.forgot':       { en: 'Forgot your password?', ar: 'هل نسيت كلمة المرور؟' },
  'staff.createAccount':{ en: 'Create an e-mail account', ar: 'إنشاء حساب بالبريد الإلكتروني' },
  'staff.fullName':     { en: 'Full name', ar: 'الاسم الكامل' },
  'staff.newPassword':  { en: 'New password', ar: 'كلمة مرور جديدة' },
  'staff.choosePassword': { en: 'Choose a new password', ar: 'اختر كلمة مرور جديدة' },
  'staff.savePassword': { en: 'Save new password', ar: 'حفظ كلمة المرور' },
  'staff.back':         { en: '← Back to sign in', ar: '→ العودة إلى تسجيل الدخول' },
  'staff.signupNote':   { en: 'New accounts are ordinary employee accounts. Administrator access is granted by an existing administrator.',
                          ar: 'الحسابات الجديدة حسابات موظفين عادية. صلاحية المسؤول يمنحها مسؤول حالي.' },
  'admin.orgName':      { en: 'Organisation name', ar: 'اسم المؤسسة' },
  'admin.trackedPerson':{ en: 'Tracked person',    ar: 'الشخص المتابَع' },
  'admin.quickDurations': { en: 'Quick duration buttons (minutes, comma separated)',
                            ar: 'أزرار المدة السريعة (بالدقائق، مفصولة بفواصل)' },
  'admin.saveSettings': { en: 'Save settings', ar: 'حفظ الإعدادات' },
  'admin.pushTitle':    { en: 'Notifications on this device', ar: 'الإشعارات على هذا الجهاز' },
  'admin.pushOn':       { en: 'Turn on notifications', ar: 'تفعيل الإشعارات' },
  'admin.pushOff':      { en: 'Turn off', ar: 'إيقاف' },
  'admin.pushTest':     { en: 'Send a test', ar: 'إرسال تجربة' },
  'admin.pushRereg':    { en: 'Re-register this device', ar: 'إعادة تسجيل هذا الجهاز' },
  'push.brave':         { en: 'Brave blocks notifications unless you allow Google push messaging: brave://settings/privacy, turn on "Use Google services for push messaging", then restart Brave. Installing this app from Chrome instead also works.',
                          ar: 'يحجب متصفح Brave الإشعارات ما لم تسمح بخدمة Google للإشعارات: افتح brave://settings/privacy وفعّل "Use Google services for push messaging" ثم أعد تشغيل Brave. أو ثبّت التطبيق من Chrome بدلاً من ذلك.' },
  'admin.pushReregistered': { en: 'Device re-registered. Notifications should arrive again.',
                              ar: 'تمت إعادة تسجيل الجهاز. يُفترض أن تصل الإشعارات مجدداً.' },
  'admin.pushReregisterFailed': { en: 'Could not re-register. Turn notifications off and on again.',
                                  ar: 'تعذّرت إعادة التسجيل. أوقف الإشعارات ثم أعد تفعيلها.' },
  'admin.pushDevices':  { en: '{n} devices registered.', ar: '{n} أجهزة مسجّلة.' },
  'admin.pushDevices1': { en: '1 device registered.',    ar: 'جهاز واحد مسجّل.' },
  'admin.pushTestNote': { en: '"Send a test" only proves this phone can display a notification. It does not go through the server, so it cannot tell you whether real requests will arrive.',
                          ar: '"إرسال تجربة" يثبت فقط أن هذا الهاتف قادر على عرض إشعار. لا يمر عبر الخادم، لذا لا يخبرك إن كانت الطلبات الحقيقية ستصل.' },
  'admin.pushHint':     { en: 'New requests always appear here instantly while the app is open. Turning notifications on also alerts you when it is closed.',
                          ar: 'تظهر الطلبات الجديدة فوراً أثناء فتح التطبيق. تفعيل الإشعارات ينبّهك أيضاً عندما يكون مغلقاً.' },
  'admin.recentChanges':{ en: 'Recent configuration changes', ar: 'آخر تغييرات الإعدادات' },
  'admin.noChanges':    { en: 'No changes recorded yet', ar: 'لا توجد تغييرات مسجلة' },
  'admin.session':      { en: 'Session', ar: 'الجلسة' },
  'admin.access':       { en: 'Access',  ar: 'الوصول' },
  'admin.removeSection':{ en: 'Remove', ar: 'حذف' },
  'admin.deleteRequest':{ en: 'Delete this request', ar: 'حذف هذا الطلب' },
  'admin.deleteHint':   { en: 'For a request you created while testing. It disappears from the queue, the history and every report.',
                          ar: 'لطلب أنشأته أثناء التجربة. سيختفي من الطابور والسجل وكل التقارير.' },
  'admin.deleteConfirm':{ en: 'Delete {number} permanently? This cannot be undone.',
                          ar: 'حذف {number} نهائياً؟ لا يمكن التراجع عن هذا.' },
  'admin.deletedToast': { en: '{number} deleted.', ar: 'تم حذف {number}.' },

  'admin.testData':     { en: 'Before going live', ar: 'قبل التشغيل الفعلي' },
  'admin.testDataHint': { en: 'Clears what you created while trying the app out. Real requests look exactly like test ones once they are saved, so use these only before your colleagues start sending anything.',
                          ar: 'يمسح ما أنشأته أثناء تجربة التطبيق. الطلبات الحقيقية تبدو مطابقة للتجريبية بعد حفظها، لذا استخدم هذا قبل أن يبدأ زملاؤك بالإرسال.' },
  'admin.purgeRequests':{ en: 'Clear all requests', ar: 'مسح كل الطلبات' },
  'admin.purgeRequestsQ': { en: 'Delete every request in the system? Numbering restarts from 1.',
                            ar: 'حذف كل الطلبات في النظام؟ سيبدأ الترقيم من 1 من جديد.' },
  'admin.purgeRequestsQ2': { en: 'Last check: {n} are open right now. Delete everything?',
                             ar: 'تأكيد أخير: يوجد {n} طلب مفتوح الآن. حذف الكل؟' },
  'admin.purgeYes':     { en: 'Yes, delete', ar: 'نعم، احذف' },
  'admin.purgedToast':  { en: '{n} requests deleted. Numbering restarts.',
                          ar: 'تم حذف {n} طلب. سيبدأ الترقيم من جديد.' },
  'admin.purgeActivity':{ en: 'Clear my activity log', ar: 'مسح سجل نشاطي' },
  'admin.purgeActivityQ': { en: 'Delete every status you have posted? Reports and history start from nothing. Requests are not affected.',
                            ar: 'حذف كل الحالات التي نشرتها؟ ستبدأ التقارير والسجل من الصفر. الطلبات لن تتأثر.' },
  'admin.purgedActivityToast': { en: '{n} activity records deleted.', ar: 'تم حذف {n} سجل نشاط.' },
  'admin.unlocked':     { en: 'Admin console unlocked on this device.',
                          ar: 'تم فتح لوحة التحكم على هذا الجهاز.' },
  /* Arabic counts in three forms: one, two, then many. English needs two. */
  'admin.tapsLeft1':    { en: '1 more tap…',   ar: 'بقيت ضغطة واحدة…' },
  'admin.tapsLeft2':    { en: '2 more taps…',  ar: 'بقيت ضغطتان…' },
  'admin.tapsLeft':     { en: '{n} more taps…', ar: 'بقيت {n} ضغطات…' },
  'admin.hideLink':     { en: 'Hide the admin link on this device',
                          ar: 'إخفاء رابط لوحة التحكم من هذا الجهاز' },
  'admin.hideLinkHint': { en: 'Use this on a shared or borrowed phone. Ten taps on the clock brings it back.',
                          ar: 'استخدمه على هاتف مشترك أو مُعار. عشر ضغطات على الساعة تعيده.' },
  'admin.hideLinkConfirm': { en: 'Hide the admin link on this device? Ten taps on the clock will bring it back.',
                             ar: 'إخفاء رابط لوحة التحكم من هذا الجهاز؟ عشر ضغطات على الساعة تعيده.' },
  'admin.hiddenToast':  { en: 'Admin link hidden on this device.',
                          ar: 'تم إخفاء رابط لوحة التحكم من هذا الجهاز.' },
  'admin.signOut':      { en: 'Sign out', ar: 'تسجيل الخروج' },
  'admin.signOutConfirm': { en: 'Sign out of the admin console?', ar: 'تسجيل الخروج من لوحة التحكم؟' },
  'admin.emailSignup':  { en: 'Allow new administrator sign-up by e-mail', ar: 'السماح بإنشاء حساب مسؤول بالبريد الإلكتروني' },
  'admin.emailSignupHint': { en: 'Leave this off unless you are adding another administrator. Employees never need accounts.',
                             ar: 'اتركه معطّلاً إلا عند إضافة مسؤول آخر. الزملاء لا يحتاجون حسابات أبداً.' },

  /* ================= durations and relative time ================= */
  'time.justNow':  { en: 'just now',   ar: 'الآن' },
  'time.in':       { en: 'in {v}',     ar: 'بعد {v}' },
  'time.ago':      { en: '{v} ago',    ar: 'منذ {v}' },
  'time.min':      { en: '{n}m',       ar: '{n} د' },
  'time.hour':     { en: '{n}h',       ar: '{n} س' },
  'time.hourMin':  { en: '{n}h {m}m',  ar: '{n} س {m} د' },
  'time.day':      { en: '{n} day',    ar: 'يوم واحد' },
  'time.days':     { en: '{n} days',   ar: '{n} أيام' },

  /* ================= errors ================= */
  'error.generic':      { en: 'Something went wrong. Please try again.', ar: 'حدث خطأ ما. يُرجى المحاولة مرة أخرى.' },
  'error.offline':      { en: 'You appear to be offline. Reconnect and try again.', ar: 'يبدو أنك غير متصل. أعد الاتصال وحاول مجدداً.' },
  'error.bootTitle':    { en: 'The admin console could not start', ar: 'تعذّر تشغيل لوحة التحكم' },
  'admin.signOutAndIn': { en: 'Sign out and sign in again', ar: 'تسجيل الخروج ثم الدخول من جديد' },
  'admin.notAdmin':     { en: 'You are signed in as {who}, which is not an administrator account. If you created this account just now, sign out and sign in with your administrator e-mail instead.',
                          ar: 'أنت مسجّل الدخول باسم {who}، وهو ليس حساب مسؤول. إذا أنشأت هذا الحساب للتو، سجّل الخروج ثم ادخل ببريد المسؤول.' },
  'error.notFound':     { en: 'That page does not exist', ar: 'هذه الصفحة غير موجودة' }
};

/* ------------------------------------------------------------------ */
/* Runtime                                                             */
/* ------------------------------------------------------------------ */

let current = resolveInitial();
const listeners = new Set();

function resolveInitial() {
  const saved = store.get('lang');
  if (saved && LANGS[saved]) return saved;
  // First visit: follow the browser, defaulting to English.
  const nav = (navigator.languages || [navigator.language || 'en']).join(',').toLowerCase();
  return nav.includes('ar') ? 'ar' : 'en';
}

export const getLang = () => current;
export const getDir = () => LANGS[current].dir;
export const isRTL = () => LANGS[current].dir === 'rtl';
export const getLocale = () => LANGS[current].locale;

/**
 * Translate a key. `vars` fills {placeholders}.
 * An unknown key returns the key itself, which makes gaps obvious
 * during development rather than rendering an empty box.
 */
export function t(key, vars) {
  const entry = STRINGS[key];
  let out = entry ? (entry[current] ?? entry.en ?? key) : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

/** Fills every translatable attribute under `root`. */
export function apply(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(node => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(node => {
    node.setAttribute('placeholder', t(node.dataset.i18nPh));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach(node => {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(node => {
    node.setAttribute('title', t(node.dataset.i18nTitle));
  });

  if (root === document) {
    const titleKey = document.documentElement.dataset.titleKey;
    if (titleKey) document.title = t(titleKey);
  }
}

/** Applies `lang`/`dir` to the document so CSS logical properties mirror. */
export function applyDocument() {
  const html = document.documentElement;
  html.lang = current;
  html.dir = LANGS[current].dir;
  apply(document);
}

/**
 * Switches language in place. Subscribers re-render their dynamic
 * content, so the current screen and scroll position are preserved —
 * nothing navigates.
 */
export function setLang(lang) {
  if (!LANGS[lang] || lang === current) return current;
  current = lang;
  store.set('lang', lang);
  applyDocument();
  listeners.forEach(fn => { try { fn(lang); } catch (err) { console.error(err); } });
  return current;
}

export function toggleLang() {
  return setLang(current === 'ar' ? 'en' : 'ar');
}

/** Register a re-render callback. Returns an unsubscribe function. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Wires the العربية | English switcher present in every app bar. */
export function initLangToggle(selector = '[data-lang-toggle]') {
  document.querySelectorAll(selector).forEach(btn => {
    const paint = () => {
      // Show the language you would switch TO.
      btn.textContent = current === 'ar' ? 'English' : 'العربية';
      btn.setAttribute('aria-label', current === 'ar' ? 'Switch to English' : 'التبديل إلى العربية');
      btn.setAttribute('lang', current === 'ar' ? 'en' : 'ar');
    };
    btn.addEventListener('click', () => { toggleLang(); paint(); });
    paint();
  });
  onLangChange(() => {
    document.querySelectorAll(selector).forEach(btn => {
      btn.textContent = current === 'ar' ? 'English' : 'العربية';
      btn.setAttribute('lang', current === 'ar' ? 'en' : 'ar');
    });
  });
}
