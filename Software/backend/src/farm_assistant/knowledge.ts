// Curated project knowledge. Simulation parameters are assumptions, never field prescriptions.
export type CropId = 'mustard' | 'chilli' | 'tomato';
export type Topic = 'overview' | 'water' | 'simulation' | 'source';
type Crop = { name: string; identity: string; water: string; simulation: string; sources: string[] };
export const cropKnowledge: Record<CropId, Crop> = {
  mustard: {
    name: 'Cải xanh ăn lá (Brassica juncea)',
    identity: 'FarmOS mô phỏng cải xanh ăn lá Brassica juncea. Đây là hồ sơ mô phỏng, không đại diện cho mọi giống cải và điều kiện canh tác.',
    water: 'Nghiên cứu về cải Brassica juncea khảo sát stress nước trong nhà kính ở Texas. Các mức 100%, 50% và 25% sức chứa đồng ruộng trong nghiên cứu không phải ngưỡng % VWC để áp dụng trực tiếp cho cảm biến.',
    simulation: 'Hồ sơ mô phỏng giả định bốn giai đoạn 10/15/15/5 ngày, rễ 0,3 m và p=0,3; hệ số Kc mượn nhóm rau nhỏ của FAO. Những giá trị này là lựa chọn kỹ thuật, không phải tham số đo trong nghiên cứu cải xanh và chưa hiệu chuẩn tại Việt Nam.',
    sources: ['Geremew và cộng sự (2021): https://doi.org/10.3390/su132413948', 'FAO-56, chương 6: https://www.fao.org/4/X0490E/x0490e0b.htm'],
  },
  chilli: {
    name: 'Ớt (Capsicum annuum)',
    identity: 'FarmOS có hồ sơ mô phỏng ớt thuộc loài Capsicum annuum; thông số tham chiếu không mặc định phù hợp với mọi giống ớt.',
    water: 'Nghiên cứu Rao (2011) khảo sát ớt tại Jodhpur, Ấn Độ và ghi nhận hệ số Kc khác nhau theo giai đoạn. Kết quả phụ thuộc giống, khí hậu và điều kiện thí nghiệm, không phải lịch tưới cho vườn của bạn.',
    simulation: 'Mô phỏng lấy Kc 0,425/0,54/0,925/0,625 là trung điểm các khoảng theo bốn giai đoạn của Rao; rễ 0,3 m theo nghiên cứu. Thời đoạn 20/30/40/30 ngày và p=0,3 là giả định hoặc tham chiếu kỹ thuật, chưa hiệu chuẩn cho giống ớt địa phương.',
    sources: ['Rao (2011), nghiên cứu ớt: https://journal.agrimetassociation.org/index.php/jam/article/download/1356/1134', 'FAO-56, chương 8: https://www.fao.org/4/X0490E/x0490e0e.htm'],
  },
  tomato: {
    name: 'Cà chua (Solanum lycopersicum)',
    identity: 'FarmOS có hồ sơ mô phỏng cà chua Solanum lycopersicum. Hồ sơ được dùng để nghiên cứu mô hình, không thay thế theo dõi cây ngoài thực tế.',
    water: 'FAO mô tả nhu cầu bốc thoát hơi theo giai đoạn cây và điều kiện thời tiết. Một nghiên cứu cà chua nhà kính tại Trung Quốc đo các hệ số theo giai đoạn; không nên áp dụng trực tiếp các giá trị đó cho mọi vườn.',
    simulation: 'Hồ sơ dựa trên FAO và nội suy: thời đoạn 30/40/40/25 ngày, rễ 0,8 m và p=0,4. Nghiên cứu nhà kính 2018 là nguồn đối chiếu riêng; không phải nguồn đo trực tiếp các hệ số FAO mà mô hình đang dùng.',
    sources: ['FAO-56, chương 6: https://www.fao.org/4/X0490E/x0490e0b.htm', 'Acquah và cộng sự (2018), cà chua nhà kính: https://doi.org/10.25165/j.ijabe.20181106.3972'],
  },
};
export const waterPrinciple = 'FAO-56 dùng ETc = Kc × ET0 để ước tính bốc thoát hơi trong điều kiện chuẩn. Kc thay đổi theo cây, giai đoạn và điều kiện canh tác; ước tính này không tự xác định lượng nước cần tưới cho một vườn cụ thể. Nguồn: https://www.fao.org/4/X0490E/x0490e0b.htm';
export const unknownAnswer = 'Kho kiến thức hiện chưa có thông tin đủ căn cứ để trả lời câu hỏi này. FarmOS hiện có tài liệu tham chiếu về cải xanh, ớt và cà chua; bạn có thể hỏi về hồ sơ mô phỏng hoặc nguồn của từng cây.';
export const farmStatusUnavailable = 'Tôi chỉ có thể báo trạng thái từ số liệu được cung cấp và không thể xác định nhu cầu tưới thực tế khi chưa đủ dữ liệu.';
