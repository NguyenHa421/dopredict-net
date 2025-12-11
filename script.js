// script.js (thay thế nội dung cũ)
document.addEventListener("DOMContentLoaded", () => {

    async function loadList(path) {
        const res = await fetch(path);
        const text = await res.text();
        return text.split("\n").map(x => x.trim()).filter(x => x.length > 0);
    }

    async function loadJSON(path) {
        const res = await fetch(path);
        return await res.json();
    }

    let data = {
        gen: [],
        mutation: [],
        cancer: [],
        stage: [],
        samples: [] // sẽ chứa mảng từ JSON mẫu
    };

    // load dữ liệu danh sách + file json mẫu
    Promise.all([
        loadList("Data_list/gen.txt"),
        loadList("Data_list/mutations.txt"),
        loadList("Data_list/cancer_types.txt"),
        loadList("Data_list/stages.txt"),
        loadJSON("Data_list/DOPredict-Net-samples.json")
    ]).then(([gen, mutation, cancer, stage, samples]) => {
        data.gen = gen;
        data.mutation = mutation;
        data.cancer = cancer;
        data.stage = stage;
        data.samples = samples;
    }).catch(err => {
        console.error("Lỗi tải dữ liệu:", err);
    });

    // Helper: lấy phần cuối khi nhập nhiều giá trị (autocomplete)
    function getLastPart(value) {
        const parts = value.split(",");
        return parts[parts.length - 1].trim();
    }

    function renderList(type, arr) {
        const listEl = document.getElementById(type + "-list");
        listEl.innerHTML = "";

        if (!arr || arr.length === 0) {
            listEl.innerHTML = `<li class="no-result">Không có kết quả</li>`;
            return;
        }

        arr.forEach(item => {
            let li = document.createElement("li");
            li.textContent = item;
            li.onclick = () => {
                const input = document.getElementById(type);
                let parts = input.value.split(",");
                // Thay thế phần cuối bằng item (giữ các phần trước)
                parts[parts.length - 1] = " " + item;
                input.value = parts.join(",").replace(/^,/, "").trim();
                listEl.style.display = "none";
            };
            listEl.appendChild(li);
        });
    }

    function filter(type) {
        const input = document.getElementById(type);
        const last = getLastPart(input.value).toLowerCase();
        const filtered = data[type].filter(i => i.toLowerCase().includes(last));
        renderList(type, filtered);
        document.getElementById(type + "-list").style.display = "block";
    }

    window.toggleList = function(type) {
        const list = document.getElementById(type + "-list");

        if (list.style.display === "block") {
            list.style.display = "none";
        } else {
            renderList(type, data[type]);
            list.style.display = "block";
        }
    };

    // ẩn tất cả dropdown (dùng khi xóa)
    function hideAllDropdowns() {
        ["gen", "mutation", "cancer", "stage"].forEach(type => {
            const list = document.getElementById(type + "-list");
            if (list) list.style.display = "none";
        });
    }

    ["gen", "mutation", "cancer", "stage"].forEach(type => {
        const input = document.getElementById(type);
        input.addEventListener("input", () => filter(type));
    });

    document.addEventListener("click", (e) => {
        ["gen", "mutation", "cancer", "stage"].forEach(type => {
            const box = document.getElementById(type + "-box");
            if (!box.contains(e.target)) {
                const list = document.getElementById(type + "-list");
                if (list) list.style.display = "none";
            }
        });
    });

    // ---- PHẦN PHÂN TÍCH & ĐỀ XUẤT THUỐC ----

    function normalizeText(s) {
        return (s || "").toString().toLowerCase().trim();
    }

    function toArrayFromInput(s) {
        if (!s) return [];
        return s.split(",").map(x => x.trim()).filter(x => x.length > 0).map(x => x.toLowerCase());
    }

    function tokenizeClinical(s) {
        if (!s) return [];
        return s.toLowerCase()
                .replace(/[^\p{L}\p{N}\s]/gu, " ")
                .split(/\s+/)
                .map(w => w.trim())
                .filter(w => w.length >= 3); // loại bỏ các từ quá ngắn
    }

    // Hàm tính điểm khớp cho mỗi bản ghi mẫu
    function scoreSample(sample, genesArr, mutsArr, cancerInput, stageInput, clinicalTokens) {
        // weights
        const W_GENE = 30;
        const W_MUT = 35;
        const W_CANCER = 20;
        const W_STAGE = 10;
        const W_CLINICAL_PER_WORD = 3;
        const W_CLINICAL_MAX = 10; // tối đa cho clinical

        let score = 0;

        const sampleGene = normalizeText(sample.gene);
        const sampleMut = normalizeText(sample.mutation);
        const sampleCancer = normalizeText(sample.cancer_type);
        const sampleStage = normalizeText(sample.stage);
        const sampleClinical = normalizeText(sample.clinical_info);

        // gene match (exact or contained)
        if (genesArr.some(g => sampleGene === g || sampleGene.includes(g) || g.includes(sampleGene))) {
            score += W_GENE;
        }

        // mutation match: check nếu bất kỳ mutation input chứa sample.mutation hoặc ngược lại
        if (mutsArr.some(m => sampleMut === m || sampleMut.includes(m) || m.includes(sampleMut))) {
            score += W_MUT;
        }

        // cancer type match (loại ung thư)
        if (cancerInput && (sampleCancer === cancerInput || sampleCancer.includes(cancerInput) || cancerInput.includes(sampleCancer))) {
            score += W_CANCER;
        }

        // stage match
        if (stageInput && (sampleStage === stageInput || sampleStage.includes(stageInput) || stageInput.includes(sampleStage))) {
            score += W_STAGE;
        }

        // clinical text: đo một số lượng từ khóa trùng lặp
        if (clinicalTokens.length > 0) {
            const sampleClinicalTokens = tokenizeClinical(sampleClinical);
            let matchedWords = 0;
            clinicalTokens.forEach(w => {
                if (sampleClinicalTokens.includes(w)) matchedWords++;
            });
            const add = Math.min(W_CLINICAL_MAX, matchedWords * W_CLINICAL_PER_WORD);
            score += add;
        }

        return score;
    }

    // Tính confidence dựa trên điểm / maxPossible
    function computeConfidence(score) {
        const MAX_POSSIBLE = 30 + 35 + 20 + 10 + 10; // =105 (theo weights)
        return Math.round(Math.min(100, (score / MAX_POSSIBLE) * 100));
    }

    // Function gộp các recommended_combination từ các bản ghi (unique)
    function mergeCombinations(results) {
        const combos = [];
        results.forEach(r => {
            if (r.sample && Array.isArray(r.sample.recommended_combination)) {
                r.sample.recommended_combination.forEach(d => {
                    if (!combos.includes(d)) combos.push(d);
                });
            } else if (r.sample && r.sample.recommended_drug) {
                if (!combos.includes(r.sample.recommended_drug)) combos.push(r.sample.recommended_drug);
            }
        });
        return combos;
    }

    // Hàm chính: phân tích input và trả về output HTML
    function analyzeAndRecommend({geneRaw, mutRaw, clinicalRaw, cancerRaw, stageRaw}) {
        const genes = toArrayFromInput(geneRaw);
        const muts = toArrayFromInput(mutRaw);
        const cancer = normalizeText(cancerRaw);
        const stage = normalizeText(stageRaw);
        const clinicalTokens = tokenizeClinical(clinicalRaw);

        // Nếu không có dữ liệu mẫu thì báo lỗi
        if (!data.samples || data.samples.length === 0) {
            return `<p>Hệ thống chưa ghi nhận trường hợp này`;
        }

        // Tính điểm cho từng bản ghi
        const scored = data.samples.map(s => {
            const score = scoreSample(s, genes, muts, cancer, stage, clinicalTokens);
            return { sample: s, score };
        }).filter(r => r.score > 0);

        // Nếu không có bản ghi có điểm > 0, thử tìm partial matches theo mutation/gene (nới lỏng)
        let results = scored;
        if (results.length === 0) {
            // partial by mutation only
            if (muts.length > 0) {
                results = data.samples.map(s => {
                    const sampleMut = normalizeText(s.mutation);
                    const matched = muts.some(m => sampleMut.includes(m) || m.includes(sampleMut));
                    return { sample: s, score: matched ? 30 : 0 };
                }).filter(r => r.score > 0);
            }
        }

        // Nếu vẫn không có, fallback: top N by simple frequency of recommended_drug
        if (results.length === 0) {
            // thống kê top recommended_drug trong toàn bộ dataset
            const freq = {};
            data.samples.forEach(s => {
                const d = s.recommended_drug || (s.recommended_combination && s.recommended_combination[0]) || null;
                if (d) {
                    const key = d.toString();
                    freq[key] = (freq[key] || 0) + 1;
                }
            });
            const top = Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0,3);
            const combos = top.map(t => t[0]);
            return `
                <h2>Kết quả phân tích (fallback)</h2>
                <p>Không tìm được bản ghi khớp chặt. Gợi ý dựa trên các thuốc phổ biến trong dữ liệu:</p>
                <ul>
                    ${combos.map(c => `<li>${c}</li>`).join("")}
                </ul>
                <p>Hãy thử chỉnh sửa input (thêm thông tin chính xác hoặc chọn đúng loại ung thư/giai đoạn).</p>
            `;
        }

        // Sắp xếp theo score giảm dần
        results.sort((a,b) => b.score - a.score);

        // Chuẩn bị output: lấy top 3
        const topN = results.slice(0, 3);
        const primary = topN[0];

        // Gộp danh sách thuốc từ các bản ghi top
        const mergedCombos = mergeCombinations(topN);

        // Tạo HTML hiển thị chi tiết
        const matchedRecordsHtml = topN.map(r => {
            const conf = computeConfidence(r.score);
            const s = r.sample;
            return `
                <div class="record-item">
                    <h4>Độ tin cậy ${conf}%</h4>
                    <p><strong>Gen:</strong> ${escapeHtml(s.gene)} | <strong>Đột biến:</strong> ${escapeHtml(s.mutation)}</p>
                    <p><strong>Ung thư:</strong> ${escapeHtml(s.cancer_type)} | <strong>Giai đoạn:</strong> ${escapeHtml(s.stage)}</p>
                    <p><strong>Thuốc đề xuất:</strong> ${escapeHtml(s.recommended_drug || "—")}</p>
                    <p><strong>Kết hợp:</strong> ${Array.isArray(s.recommended_combination) ? escapeHtml(s.recommended_combination.join(", ")) : "—"}</p>
                    <p><em>${escapeHtml(s.drug_effectiveness_info || "")}</em></p>
                </div>
            `;
        }).join("");

        const overallConfidence = computeConfidence(topN[0].score);


        // Kết luận đề xuất thuốc + kết hợp
        const resultHtml = `
            <h2>Kết quả phân tích</h2>
            <p><strong>Độ tin cậy (dựa trên bản ghi tốt nhất):</strong> ${overallConfidence}%</p>

            <h3>Gợi ý thuốc và kết hợp tối ưu</h3>
            <p><strong>Thuốc đề xuất chính:</strong> ${escapeHtml(primary.sample.recommended_drug || "Không có")}</p>
            <p><strong>Gợi ý kết hợp:</strong> ${mergedCombos.length ? escapeHtml(mergedCombos.join(", ")) : "Không có"}</p>
            <div class="section-gap"></div>
            
            <hr>

            <h3>Chi tiết bản ghi khớp (top ${topN.length})</h3>
            ${matchedRecordsHtml}
            <hr>
            <p><strong>Lưu ý:</strong> Đây là đề xuất tự động dựa trên dữ liệu mẫu. Quyết định điều trị cuối cùng phải do bác sĩ chuyên khoa đưa ra dựa trên chẩn đoán lâm sàng đầy đủ, xét nghiệm bổ sung và tình trạng bệnh nhân.</p>
        `;
        return resultHtml;
    }

    // escape HTML để tránh injection
    function escapeHtml(str) {
        if (!str && str !== 0) return "";
        return String(str)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    // Nút gửi: dùng phân tích trên
    document.getElementById("submit-btn").addEventListener("click", () => {
        const gene = document.getElementById("gen").value;
        const mutation = document.getElementById("mutation").value;
        const clinical = document.getElementById("clinical").value;
        const cancer = document.getElementById("cancer").value;
        const stage = document.getElementById("stage").value;

        if (!gene || !mutation || !clinical || !cancer || !stage) {
            showAlert();
            return;
        }

        // Phân tích & render kết quả
        const html = analyzeAndRecommend({
            geneRaw: gene,
            mutRaw: mutation,
            clinicalRaw: clinical,
            cancerRaw: cancer,
            stageRaw: stage
        });

        document.getElementById("result-box").innerHTML = html;
        document.querySelector(".right-panel").classList.add("has-data");
    });

    // Alert box show/hide
    function showAlert() {
        const alertBox = document.getElementById("alert-box");
        alertBox.classList.add("show");
    }

    document.getElementById("alert-close").addEventListener("click", () => {
        document.getElementById("alert-box").classList.remove("show");
    });

    document.addEventListener("click", (e) => {
        const alertBox = document.getElementById("alert-box");

        // Nếu đang mở và click KHÔNG nằm trong alert-box
        if (alertBox.classList.contains("show")
            && e.target.id !== "submit-btn"
            && !alertBox.contains(e.target)) {
            alertBox.classList.remove("show");
        }
    });

    // Nút xóa: xóa inputs + kết quả + ẩn dropdown
    document.getElementById("deleteBtn").addEventListener("click", () => {
        // Xóa nội dung kết quả
        document.getElementById("result-box").innerHTML = "";
        document.querySelector(".right-panel").classList.remove("has-data");

        // Xóa toàn bộ input bên trái
        const inputs = document.querySelectorAll(".left-panel input");
        inputs.forEach(i => i.value = "");

        // Xóa danh sách drop-down đang mở
        hideAllDropdowns();
    });

});
