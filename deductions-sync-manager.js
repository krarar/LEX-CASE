/**
 * Deductions Sync Manager
 * مدير مزامنة الاستقطاعات بين التطبيق الرئيسي وتطبيق المحامين
 * 
 * يحل المشاكل التالية:
 * 1. تكرار الدعاوى
 * 2. حذف الاستقطاعات عند إعادة التحميل
 * 3. مشاكل أزرار الحذف والتعديل
 */

(function() {
    'use strict';

    // التأكد من وجود Firebase
    if (typeof firebase === 'undefined') {
        console.error('Firebase غير محمل. يرجى التأكد من تحميل Firebase SDK أولاً.');
        return;
    }

    // إنشاء مدير الاستقطاعات العام
    window.DeductionsSyncManager = class DeductionsSyncManager {
        constructor() {
            this.db = firebase.database();
            this.deductionsCache = new Map(); // لتجنب التكرار
            this.isInitialized = false;
            this.listeners = [];
            
            console.log('✅ تم تهيئة مدير مزامنة الاستقطاعات');
        }

        /**
         * تهيئة المدير
         */
        async initialize() {
            if (this.isInitialized) {
                console.log('⚠️ المدير مهيأ بالفعل');
                return;
            }

            try {
                // تحميل الاستقطاعات الموجودة
                await this.loadExistingDeductions();
                
                // الاستماع للتغييرات في الوقت الفعلي
                this.setupRealtimeListeners();
                
                this.isInitialized = true;
                console.log('✅ تم تهيئة المدير بنجاح');
            } catch (error) {
                console.error('❌ خطأ في تهيئة المدير:', error);
                throw error;
            }
        }

        /**
         * تحميل الاستقطاعات الموجودة من Firebase
         */
        async loadExistingDeductions() {
            try {
                const snapshot = await this.db.ref('legal_data/deductions/payments').once('value');
                const deductions = snapshot.val();

                if (deductions) {
                    Object.entries(deductions).forEach(([key, deduction]) => {
                        // استخدام رقم القضية + التاريخ + المبلغ كمفتاح فريد
                        const uniqueKey = this.generateUniqueKey(deduction);
                        this.deductionsCache.set(uniqueKey, {
                            firebaseKey: key,
                            data: deduction
                        });
                    });
                    
                    console.log(`📥 تم تحميل ${this.deductionsCache.size} استقطاع من Firebase`);
                }
            } catch (error) {
                console.error('❌ خطأ في تحميل الاستقطاعات:', error);
                throw error;
            }
        }

        /**
         * إعداد مستمعي الوقت الفعلي
         */
        setupRealtimeListeners() {
            const deductionsRef = this.db.ref('legal_data/deductions/payments');

            // الاستماع للإضافات الجديدة
            const addedListener = deductionsRef.on('child_added', (snapshot) => {
                const deduction = snapshot.val();
                const uniqueKey = this.generateUniqueKey(deduction);
                
                if (!this.deductionsCache.has(uniqueKey)) {
                    this.deductionsCache.set(uniqueKey, {
                        firebaseKey: snapshot.key,
                        data: deduction
                    });
                    
                    console.log('➕ تم إضافة استقطاع جديد:', snapshot.key);
                    this.notifyLocalStorage();
                }
            });

            // الاستماع للتحديثات
            const changedListener = deductionsRef.on('child_changed', (snapshot) => {
                const deduction = snapshot.val();
                const uniqueKey = this.generateUniqueKey(deduction);
                
                this.deductionsCache.set(uniqueKey, {
                    firebaseKey: snapshot.key,
                    data: deduction
                });
                
                console.log('🔄 تم تحديث استقطاع:', snapshot.key);
                this.notifyLocalStorage();
            });

            // الاستماع للحذف
            const removedListener = deductionsRef.on('child_removed', (snapshot) => {
                const deduction = snapshot.val();
                const uniqueKey = this.generateUniqueKey(deduction);
                
                this.deductionsCache.delete(uniqueKey);
                
                console.log('🗑️ تم حذف استقطاع:', snapshot.key);
                this.notifyLocalStorage();
            });

            // حفظ المستمعين للتنظيف لاحقاً
            this.listeners.push({ ref: deductionsRef, event: 'child_added', callback: addedListener });
            this.listeners.push({ ref: deductionsRef, event: 'child_changed', callback: changedListener });
            this.listeners.push({ ref: deductionsRef, event: 'child_removed', callback: removedListener });
        }

        /**
         * توليد مفتاح فريد للاستقطاع لتجنب التكرار
         */
        generateUniqueKey(deduction) {
            const caseNumber = deduction.caseNumber || '';
            const amount = deduction.amount || 0;
            const date = deduction.date || '';
            const defendantName = deduction.defendantName || deduction.plaintiffName || '';
            
            return `${caseNumber}_${amount}_${date}_${defendantName}`.replace(/\s/g, '');
        }

        /**
         * إضافة استقطاع جديد مع التحقق من التكرار
         */
        async addDeduction(deductionData) {
            try {
                // التحقق من البيانات المطلوبة
                if (!deductionData.caseNumber || !deductionData.amount || !deductionData.date) {
                    throw new Error('البيانات المطلوبة ناقصة');
                }

                // التحقق من عدم وجود تكرار
                const uniqueKey = this.generateUniqueKey(deductionData);
                
                if (this.deductionsCache.has(uniqueKey)) {
                    console.warn('⚠️ الاستقطاع موجود بالفعل:', uniqueKey);
                    const existing = this.deductionsCache.get(uniqueKey);
                    return { success: false, message: 'الاستقطاع موجود بالفعل', existing: existing.data };
                }

                // توليد ID فريد
                const deductionId = Date.now() + Math.floor(Math.random() * 1000);
                
                // إعداد بيانات الاستقطاع الكاملة
                const completeDeduction = {
                    id: deductionId,
                    caseId: deductionData.caseId || deductionData.caseNumber,
                    caseNumber: deductionData.caseNumber,
                    defendantName: deductionData.defendantName || 'غير محدد',
                    plaintiffName: deductionData.plaintiffName || deductionData.caseTitle || 'غير محدد',
                    source: deductionData.source || 'محكمة البداءة',
                    lawyerId: deductionData.lawyerId || '',
                    lawyerName: deductionData.lawyerName || '',
                    amount: parseFloat(deductionData.amount),
                    type: deductionData.type || 'استقطاع',
                    status: deductionData.status || 'مستلم',
                    notes: deductionData.notes || '',
                    date: deductionData.date,
                    createdAt: new Date().toISOString(),
                    createdBy: deductionData.createdBy || 'النظام'
                };

                // الحفظ في Firebase
                const firebaseKey = `deduction_${deductionId}`;
                await this.db.ref(`legal_data/deductions/payments/${firebaseKey}`).set(completeDeduction);

                // إضافة للكاش
                this.deductionsCache.set(uniqueKey, {
                    firebaseKey: firebaseKey,
                    data: completeDeduction
                });

                // تحديث القضية المرتبطة
                await this.updateCaseDeductions(completeDeduction);

                console.log('✅ تم إضافة الاستقطاع بنجاح:', firebaseKey);
                this.notifyLocalStorage();

                return { success: true, deduction: completeDeduction, firebaseKey: firebaseKey };

            } catch (error) {
                console.error('❌ خطأ في إضافة الاستقطاع:', error);
                throw error;
            }
        }

        /**
         * تحديث استقطاع موجود
         */
        async updateDeduction(deductionId, updates) {
            try {
                // البحث عن الاستقطاع في الكاش
                let targetKey = null;
                let targetData = null;

                for (const [key, value] of this.deductionsCache.entries()) {
                    if (value.data.id === deductionId) {
                        targetKey = value.firebaseKey;
                        targetData = value.data;
                        break;
                    }
                }

                if (!targetKey) {
                    throw new Error('الاستقطاع غير موجود');
                }

                // تحديث البيانات
                const updatedData = { ...targetData, ...updates };
                
                // الحفظ في Firebase
                await this.db.ref(`legal_data/deductions/payments/${targetKey}`).update(updates);

                // تحديث الكاش
                const uniqueKey = this.generateUniqueKey(updatedData);
                this.deductionsCache.set(uniqueKey, {
                    firebaseKey: targetKey,
                    data: updatedData
                });

                console.log('✅ تم تحديث الاستقطاع بنجاح:', targetKey);
                this.notifyLocalStorage();

                return { success: true, deduction: updatedData };

            } catch (error) {
                console.error('❌ خطأ في تحديث الاستقطاع:', error);
                throw error;
            }
        }

        /**
         * حذف استقطاع
         */
        async deleteDeduction(deductionId) {
            try {
                console.log('🗑️ محاولة حذف الاستقطاع:', deductionId);

                // البحث عن الاستقطاع
                let targetKey = null;
                let targetData = null;
                let uniqueKey = null;

                for (const [key, value] of this.deductionsCache.entries()) {
                    if (value.data.id === deductionId) {
                        targetKey = value.firebaseKey;
                        targetData = value.data;
                        uniqueKey = key;
                        break;
                    }
                }

                if (!targetKey) {
                    console.error('❌ الاستقطاع غير موجود في الكاش');
                    throw new Error('الاستقطاع غير موجود');
                }

                // الحذف من Firebase
                await this.db.ref(`legal_data/deductions/payments/${targetKey}`).remove();

                // الحذف من الكاش
                this.deductionsCache.delete(uniqueKey);

                // تحديث القضية المرتبطة
                await this.updateCaseDeductions(targetData, -targetData.amount);

                console.log('✅ تم حذف الاستقطاع بنجاح:', targetKey);
                this.notifyLocalStorage();

                return { success: true };

            } catch (error) {
                console.error('❌ خطأ في حذف الاستقطاع:', error);
                throw error;
            }
        }

        /**
         * الحصول على جميع الاستقطاعات
         */
        getAllDeductions() {
            const deductions = [];
            this.deductionsCache.forEach((value) => {
                deductions.push(value.data);
            });
            return deductions;
        }

        /**
         * الحصول على استقطاعات قضية معينة
         */
        getCaseDeductions(caseNumber) {
            const deductions = [];
            this.deductionsCache.forEach((value) => {
                if (value.data.caseNumber === caseNumber) {
                    deductions.push(value.data);
                }
            });
            return deductions;
        }

        /**
         * تحديث إجمالي الاستقطاعات للقضية
         */
        async updateCaseDeductions(deductionData, amountChange = null) {
            try {
                const caseNumber = deductionData.caseNumber;
                
                // البحث عن القضية
                const casesSnapshot = await this.db.ref('legal_data/cases/active').once('value');
                const allCases = casesSnapshot.val();

                if (!allCases) return;

                let caseKey = null;
                let caseData = null;

                for (const [key, caseItem] of Object.entries(allCases)) {
                    if (caseItem.caseNumber === caseNumber) {
                        caseKey = key;
                        caseData = caseItem;
                        break;
                    }
                }

                if (!caseKey) {
                    console.warn('⚠️ القضية غير موجودة:', caseNumber);
                    return;
                }

                // حساب إجمالي الاستقطاعات
                let totalDeductions = 0;
                if (amountChange !== null) {
                    // عند الحذف
                    totalDeductions = (caseData.deductions || 0) + amountChange;
                } else {
                    // عند الإضافة أو التحديث - حساب من جديد
                    const caseDeductions = this.getCaseDeductions(caseNumber);
                    totalDeductions = caseDeductions.reduce((sum, d) => sum + (d.amount || 0), 0);
                }

                // التأكد من عدم السالب
                if (totalDeductions < 0) totalDeductions = 0;

                // تحديث القضية
                await this.db.ref(`legal_data/cases/active/${caseKey}`).update({
                    deductions: totalDeductions,
                    lastUpdate: new Date().toISOString()
                });

                console.log('✅ تم تحديث إجمالي استقطاعات القضية:', caseNumber, '=', totalDeductions);

            } catch (error) {
                console.error('❌ خطأ في تحديث استقطاعات القضية:', error);
            }
        }

        /**
         * إشعار localStorage بالتغييرات
         */
        notifyLocalStorage() {
            try {
                const deductions = this.getAllDeductions();
                
                // تحديث localStorage
                localStorage.setItem('deductionsData', JSON.stringify(deductions));
                
                // إطلاق حدث مخصص لتحديث الواجهة
                window.dispatchEvent(new CustomEvent('deductionsUpdated', { 
                    detail: { deductions: deductions }
                }));
                
            } catch (error) {
                console.error('❌ خطأ في تحديث localStorage:', error);
            }
        }

        /**
         * مزامنة localStorage مع Firebase
         */
        async syncLocalStorageToFirebase() {
            try {
                console.log('🔄 جاري مزامنة localStorage مع Firebase...');
                
                const localData = localStorage.getItem('deductionsData');
                if (!localData) {
                    console.log('⚠️ لا توجد بيانات في localStorage');
                    return;
                }

                const localDeductions = JSON.parse(localData);
                let addedCount = 0;

                for (const deduction of localDeductions) {
                    const uniqueKey = this.generateUniqueKey(deduction);
                    
                    if (!this.deductionsCache.has(uniqueKey)) {
                        // الاستقطاع غير موجود في Firebase، نضيفه
                        await this.addDeduction(deduction);
                        addedCount++;
                    }
                }

                console.log(`✅ تمت المزامنة: تم إضافة ${addedCount} استقطاع`);

            } catch (error) {
                console.error('❌ خطأ في المزامنة:', error);
            }
        }

        /**
         * تنظيف المستمعين
         */
        cleanup() {
            this.listeners.forEach(({ ref, event, callback }) => {
                ref.off(event, callback);
            });
            this.listeners = [];
            console.log('🧹 تم تنظيف المستمعين');
        }
    };

    // إنشاء instance عام
    window.deductionsSyncManager = new window.DeductionsSyncManager();

    // تهيئة تلقائية عند التحميل
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.deductionsSyncManager.initialize().catch(console.error);
        });
    } else {
        window.deductionsSyncManager.initialize().catch(console.error);
    }

    // إضافة دوال مساعدة عامة
    window.addDeductionSafe = async function(deductionData) {
        try {
            return await window.deductionsSyncManager.addDeduction(deductionData);
        } catch (error) {
            console.error('خطأ في إضافة الاستقطاع:', error);
            return { success: false, error: error.message };
        }
    };

    window.deleteDeductionSafe = async function(deductionId) {
        try {
            return await window.deductionsSyncManager.deleteDeduction(deductionId);
        } catch (error) {
            console.error('خطأ في حذف الاستقطاع:', error);
            return { success: false, error: error.message };
        }
    };

    window.updateDeductionSafe = async function(deductionId, updates) {
        try {
            return await window.deductionsSyncManager.updateDeduction(deductionId, updates);
        } catch (error) {
            console.error('خطأ في تحديث الاستقطاع:', error);
            return { success: false, error: error.message };
        }
    };

    console.log('🚀 تم تحميل مدير مزامنة الاستقطاعات بنجاح');

})();